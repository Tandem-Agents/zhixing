/**
 * RpcConversationFacade —— cli 经 RPC 接入核心宿主的会话域方法门面。
 *
 * 对标 RpcSchedulerFacade:facade 是方法域封装、不持连接——连接是进程级
 * 共享的 CoreHostRpcLink(调度 / 会话 / 确认域共用一条已认证连接),建立 /
 * 重连 / 释放归连接持有者。
 *
 * 方法调用按需 ensure 宿主;通知订阅(onDelta / onComplete / onChanged /
 * onActivity / onPostTurnControlIntent)走连接的持久订阅——跨重连有效且被动,
 * 不为订阅拉起宿主。payload 类型取自 server 的 wire 契约单源,两侧不各自手写镜像。
 *
 * handler 收到的 payload 含 conversationId——"当前对话"是接入面 UI 态,
 * 过滤归调用方,facade 对此零知识。
 */

import type {
  ConversationUncertainResolutionResult,
  ConversationCommunicationHistory as RunsPage,
  ConversationHistoryCursor as RunsPageCursor,
} from "@zhixing/core/conversation/application";
import type {
  SessionInputReceipt,
  SessionChangedPayload,
  SessionActivityPayload,
  SessionAdvancementCancelResult,
  SessionAdvancementConfirmResult,
  SessionAdvancementReviseResult,
  SessionCompactResult,
  SessionContextBudgetResult,
  SessionCompletePayload,
  SessionConversationEntry,
  SessionContinuationConsent,
  SessionDeltaPayload,
  SessionListResult,
  SessionPostTurnControlIntentPayload,
  SessionNewResult,
  SessionRenameResult,
  SessionResumeResult,
  SessionSendResult,
  SessionSubscribeResult,
  SessionTaskListAction,
  SessionTaskListResult,
  SessionTaskListUpdateResult,
  SessionAdvancementDetailResult,
  SessionRubricPersistenceChoice,
  SessionSendEngage,
  SessionUsageResult,
} from "@zhixing/rpc";
import { generateTurnId, type UserTurnInput } from "@zhixing/core/types";
import type {
  ConversationStatusNotice,
  FinalFrame,
  StreamFrame,
} from "@zhixing/core/contracts";
import {
  RpcClientError,
  RpcClientClosedError,
  RpcRequestInterruptedError,
  RPC_ERROR_CODES,
  type RpcClient,
  type RpcEncodedJsonSource,
} from "@zhixing/server/client";
import { SESSION_NOTIFICATIONS } from "@zhixing/rpc/session-wire";
import type { ConversationControlCursor, ConversationControlPage, ConversationInputCursor, ConversationInputPage } from '@zhixing/core/contracts';
import { boundedControlProjection } from './control-projection.js';
import type { CoreHostRpcLink } from "./core-host-connection.js";

export interface SessionHistoryOptions {
  /** 单页 run 数上限(宿主默认 20、上限 200) */
  limit?: number;
  /** 倒读分页游标——续读上一页末条之前的内容 */
  before?: RunsPageCursor;
}

export interface ConversationStatusCursor {
  readonly conversationId: string;
  readonly runId: string;
  readonly afterStatusRevision: number;
}

export interface SessionSendSnapshotIdentity {
  readonly conversationId?: string;
  readonly turnId: string;
  readonly surfaceCapabilities: { readonly postTurnControl: true };
  readonly acceptLimitedCapabilities?: true;
}
export interface DisposableSessionSendSource extends RpcEncodedJsonSource { dispose(): Promise<void> }

export interface SessionSendRecovery {
  pending(error: unknown, automatic: boolean): void | Promise<void>;
  waitForRetry(signal?: AbortSignal): Promise<void>;
}

class InputReceiptRejectedError extends RpcClientError {
  constructor() { super(RPC_ERROR_CODES.INVALID_PARAMS, "原输入未被接纳，草稿已保留。"); }
}

export class PendingInputReceiptError extends Error {
  constructor(message = "操作结果尚待核对；请重试同一操作，系统只查询原结果，不会重复执行。") { super(message); this.name = "PendingInputReceiptError"; }
}

export class RpcConversationFacade {
  #continuationRequirement: readonly string[] | null = null;
  #limitedCapabilitiesAccepted = false;
  #pendingAdvancement = new Map<string, { method: string; key: string; submissionId: string }>();

  constructor(private readonly link: CoreHostRpcLink) {}

  // ─── 方法域 ───

  /**
   * 变更型调用的共享重连原语:断线后以完全相同的参数(含调用前生成的稳定
   * 操作身份)重放同一请求,由服务端 exact replay 消除响应丢失歧义。
   * 所有第一方变更型 surface 调用必须经此发出,不得各自实现重试。
   */
  async #requestWithReconnect<T>(method: string, params: unknown): Promise<T> {
    while (true) {
      const client = await this.link.getClient();
      try {
        return await client.request<T>(method, params);
      } catch (error) {
        if (!(error instanceof RpcClientClosedError)) throw error;
      }
    }
  }

  /** 发送一个 turn(经宿主唯一串行点入队);turnId 由发起端预分配以闭合通知竞态。 */
  async send(
    input: string | UserTurnInput,
    conversationId: string | undefined,
    turnId: string,
    options: { readonly engage?: SessionSendEngage } = {},
  ): Promise<SessionSendResult> {
    const client = await this.link.getClient();
    try { return await client.request<SessionSendResult>("session.send", {
      ...(typeof input === "string" ? { text: input } : { input }),
      ...this.#sendIdentity(conversationId, turnId),
      ...(options.engage ? { engage: options.engage } : {}),
    }); } catch (error) {
      if (!conversationId || definitelyUnsubmitted(error)) throw error;
      return this.#recoverInput<SessionSendResult>(conversationId, turnId, error, { pending: () => undefined, waitForRetry: async () => { throw error; } }, undefined);
    }
  }

  /** Freeze once. A lost response is recovered by its read-only receipt;
   * session.send can enter Advancement and must not be blindly replayed. */
  async sendPrepared<T = SessionSendResult>(
    prepare: (identity: SessionSendSnapshotIdentity, signal: AbortSignal, maximumBytes: number) => Promise<DisposableSessionSendSource>,
    conversationId: string | undefined, turnId: string, signal?: AbortSignal,
    consume?: (result: SessionSendResult) => T,
    recovery?: SessionSendRecovery,
  ): Promise<T> {
    const identity = this.#sendIdentity(conversationId, turnId);
    let source: DisposableSessionSendSource | undefined;
    try {
      const client = await this.link.getClient();
      if (!client.prepareRequestSource || !client.maximumRequestSourceBytes || !client.requestEncoded) throw Error('当前连接不支持有界输入准备，草稿已保留。');
      const maximum = client.maximumRequestSourceBytes('session.send');
      const prepared = await client.prepareRequestSource(async preparationSignal => {
        const value = await prepare(identity, preparationSignal, maximum);
        // Cancellation may settle the caller while local IO is still ending.
        // A source published late still has an owner that disposes it here.
        if (preparationSignal.aborted) { await value.dispose().catch(() => {}); preparationSignal.throwIfAborted(); }
        source = value; return value;
      }, signal);
      try {
        return await this.#sendSource(source!, client, prepared.deadline, signal, consume);
      } catch (error) {
        if (!recovery || !conversationId || definitelyUnsubmitted(error)) throw error;
        // Release the cold transport source before a user-paced receipt wait.
        // The terminal's frozen draft remains owned independently.
        await source?.dispose().catch(() => {}); source = undefined;
        return await this.#recoverInput(conversationId, turnId, error, recovery, signal, consume);
      }
    } finally {
      // Physical/account uncertainty remains charged by the source owner. A
      // late cleanup failure cannot retract the server's D06 acceptance.
      await source?.dispose().catch(() => {});
    }
  }

  #sendIdentity(conversationId: string | undefined, turnId: string): SessionSendSnapshotIdentity {
    return { conversationId, turnId, surfaceCapabilities: { postTurnControl: true }, ...this.#continuationConsent() };
  }

  async #sendSource<T>(source: RpcEncodedJsonSource, first: RpcClient, deadline: number, signal: AbortSignal | undefined, consume?: (result: SessionSendResult) => T): Promise<T> {
    signal?.throwIfAborted();
    if (!first.requestEncoded) throw Error('当前连接不支持有界输入发送，草稿已保留。');
    if (consume && first.consumeEncoded) return first.consumeEncoded<SessionSendResult, T>('session.send', source, consume, { deadline, signal });
    const result = await first.requestEncoded<SessionSendResult>('session.send', source, { deadline, signal });
    return consume ? consume(result) : result as T;
  }

  async #recoverInput<T>(conversationId: string, turnId: string, firstError: unknown, recovery: SessionSendRecovery,
    signal: AbortSignal | undefined, consume?: (result: SessionSendResult) => T): Promise<T> {
    let cause = firstError;
    for (;;) {
      for (let attempt = 0; attempt < 3; attempt++) {
        signal?.throwIfAborted();
        await recovery.pending(cause, true);
        let receipt: SessionInputReceipt;
        let consuming = false;
        try {
          const client = await this.link.getClient();
          const project = (value: SessionInputReceipt): { done: true; value: T } | { done: false; receipt: SessionInputReceipt } => {
            let result: SessionSendResult | undefined;
            if (value.status === 'settled' && value.conversationId === conversationId && value.turnId === turnId && value.result.conversationId === conversationId) result = value.result;
            else if (value.status === 'accepted' && value.conversationId === conversationId && value.turnId === turnId && value.runId) result = { conversationId, sessionId: conversationId, turnId, runId: value.runId };
            if (!result) return { done: false, receipt: value };
            consuming = true;
            return { done: true, value: consume ? consume(result) : result as T };
          };
          const params = { conversationId, turnId }, options = { signal, deadline: Date.now() + 5000 };
          const checked = client.consume
            ? await client.consume('session.inputReceipt', params, project, options)
            : project(await client.request<SessionInputReceipt>('session.inputReceipt', params, options));
          if (checked.done) return checked.value;
          receipt = checked.receipt;
        } catch (error) { if (consuming) throw error; cause = error; continue; }
        if (receipt.status === 'accepted' || receipt.status === 'settled') { cause = Error('Input receipt identity mismatch'); continue; }
        if (receipt.status === 'rejected') throw new InputReceiptRejectedError();
        // An absent receipt can precede the original authority commit. Never
        // turn it into a rejection or issue another session.send.
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
          const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 500);
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
      await recovery.pending(cause, false);
      await recovery.waitForRetry(signal);
    }
  }


  hasPendingAdvancement(conversationId: string): boolean {
    return this.#pendingAdvancement.has(conversationId);
  }

  /** Read the saved submission, independently of the currently displayed draft
   * or button. The consumer takes responsibility before the identity retires. */
  async consumePendingAdvancement<T>(conversationId: string, consume: (result: SessionSendResult) => T): Promise<T | undefined> {
    const identity = this.#pendingAdvancement.get(conversationId);
    if (!identity) return undefined;
    try {
      return await this.#recoverInput<T>(conversationId, identity.submissionId, new PendingInputReceiptError(), {
        pending: () => undefined,
        waitForRetry: async () => { throw new PendingInputReceiptError(); },
      }, undefined, result => {
        const value = consume(result);
        if (this.#pendingAdvancement.get(conversationId) === identity) this.#pendingAdvancement.delete(conversationId);
        return value;
      });
    } catch (error) {
      if (error instanceof InputReceiptRejectedError && this.#pendingAdvancement.get(conversationId) === identity) this.#pendingAdvancement.delete(conversationId);
      throw error;
    }
  }

  /** A button retry checks the previous identity; it never replays a mutation. */
  async #advancementRequest<T, R = T>(method: string, conversationId: string, params: Record<string, unknown>,
    project: (result: SessionSendResult) => T, consume?: (result: T) => R): Promise<R> {
    const key = JSON.stringify({ method, params });
    const pending = this.#pendingAdvancement.get(conversationId);

    if (pending && pending.key !== key) throw new PendingInputReceiptError("上次操作结果尚待核对；请先重试上一次操作，再选择其他操作。");
    const identity = pending ?? { method, key, submissionId: generateTurnId() };
    if (!pending && this.#pendingAdvancement.size >= 64) throw Error("尚有未核对的任务操作，请先核对其结果。");
    this.#pendingAdvancement.set(conversationId, identity);
    let cause: unknown = Error("上次操作结果待核对");
    if (!pending) {
      let client: RpcClient;
      try { client = await this.link.getClient(); } catch (error) { this.#pendingAdvancement.delete(conversationId); throw error; }
      let delivered = false;
      try {
        const input = { ...params, submissionId: identity.submissionId };
        const accept = (value: T): R => {
          delivered = true;
          const result = consume ? consume(value) : value as unknown as R;
          if (this.#pendingAdvancement.get(conversationId) === identity) this.#pendingAdvancement.delete(conversationId);
          return result;
        };
        const result = consume && client.consume ? await client.consume<T, R>(method, input, accept)
          : accept(await client.request<T>(method, input));
        this.#pendingAdvancement.delete(conversationId); return result;
      } catch (error) {
        if (delivered) throw error;
        if (definitelyUnsubmitted(error)) { this.#pendingAdvancement.delete(conversationId); throw error; }
        cause = error;
      }
    }
    try { return await this.#recoverInput<R>(conversationId, identity.submissionId, cause, {
      pending: () => undefined,
      waitForRetry: async () => { throw new PendingInputReceiptError(); },
    }, undefined, result => {
      const projected = project(result);
      const value = consume ? consume(projected) : projected as unknown as R;
      if (this.#pendingAdvancement.get(conversationId) === identity) this.#pendingAdvancement.delete(conversationId);
      return value;
    }); } catch (error) {
      if (error instanceof InputReceiptRejectedError) this.#pendingAdvancement.delete(conversationId);
      throw error;
    }
  }

  /** 对话列表——盘上全量叠加活跃态(/resume 候选源)。 */
  async list(): Promise<SessionConversationEntry[]> {
    return (await this.listPage()).conversations;
  }

  async listPage(page?: import('@zhixing/core/conversation/application').ConversationDirectoryPageRequest): Promise<SessionListResult> {
    const client = await this.link.getClient();
    const result = await client.request<SessionListResult>("session.list", page ? { page } : undefined);
    const nextRequirement =
      result.availability?.capabilitySet === "limited" &&
      result.availability.continuationConfirmation === "required"
        ? Object.freeze([...result.availability.unavailableCapabilities])
        : null;
    if (!sameCapabilities(this.#continuationRequirement, nextRequirement)) {
      this.#limitedCapabilitiesAccepted = false;
    }
    this.#continuationRequirement = nextRequirement;
    return result;
  }

  pendingContinuationConfirmation(): readonly string[] | null {
    return this.#continuationRequirement && !this.#limitedCapabilitiesAccepted
      ? this.#continuationRequirement
      : null;
  }

  confirmContinuation(): void {
    if (this.#continuationRequirement) {
      this.#limitedCapabilitiesAccepted = true;
    }
  }

  #continuationConsent(): SessionContinuationConsent | Record<string, never> {
    return this.#continuationRequirement && this.#limitedCapabilitiesAccepted
      ? { acceptLimitedCapabilities: true }
      : {};
  }

  /** 倒读落盘事实流(新→旧分页),不要求会话活跃。 */
  async history(
    conversationId: string,
    opts: SessionHistoryOptions = {},
  ): Promise<RunsPage> {
    const client = await this.link.getClient();
    return client.request<RunsPage>("session.history", {
      conversationId,
      limit: opts.limit,
      before: opts.before,
    });
  }

  /** Retain the transport's response ownership through bounded display IO. */
  async consumeHistory<T>(
    conversationId: string,
    opts: SessionHistoryOptions,
    consume: (page: RunsPage) => Promise<T>,
  ): Promise<T> {
    const client = await this.link.getClient();
    const params = { conversationId, limit: opts.limit, before: opts.before };
    if (client.consume) return client.consume<RunsPage, T>("session.history", params, consume);
    // Existing non-WebSocket first-party ingress clients retain their own
    // transport ownership; this callback still ends with the page consumer.
    return consume(await client.request<RunsPage>("session.history", params));
  }

  /** 对话改名;返回的 conversationId 保持入参全域键。 */
  async rename(conversationId: string, name: string): Promise<SessionRenameResult> {
    const client = await this.link.getClient();
    return client.request<SessionRenameResult>("session.rename", {
      conversationId,
      name,
      ...this.#continuationConsent(),
    });
  }

  /** 删除对话(活跃运行时释放 + 落盘数据删除);断线以同一 requestId 重放。 */
  async delete(conversationId: string): Promise<void> {
    await this.#requestWithReconnect("session.delete", {
      conversationId,
      requestId: `delete:${generateTurnId()}`,
      ...this.#continuationConsent(),
    });
  }

  /** 中止当前 in-flight turn / 撤回排队项。 */
  async abort(
    conversationId: string,
    requestId: string,
    runId?: string,
  ): Promise<void> {
    await this.#requestWithReconnect("session.abort", {
      conversationId,
      requestId,
      ...(runId ? { runId } : {}),
      ...this.#continuationConsent(),
    });
  }

  async statusHistory(
    cursors: readonly ConversationStatusCursor[],
  ): Promise<{
    readonly notices: readonly ConversationStatusNotice[];
    readonly next: readonly ConversationStatusCursor[];
  }> {
    const client = await this.link.getClient();
    const groups = new Map<string, ConversationStatusCursor[]>();
    for (const cursor of cursors) {
      const group = groups.get(cursor.conversationId) ?? [];
      group.push(cursor);
      groups.set(cursor.conversationId, group);
    }
    const notices: ConversationStatusNotice[] = [];
    const next: ConversationStatusCursor[] = [];
    for (const [conversationId, group] of groups) {
      for (let offset = 0; offset < group.length; offset += 64) {
        const page = await client.request<{
          readonly notices: readonly ConversationStatusNotice[];
          readonly next: readonly ConversationStatusCursor[];
        }>("session.statusHistory", {
          conversationId,
          cursors: group.slice(offset, offset + 64).map(({ runId, afterStatusRevision }) => ({ runId, afterStatusRevision })),
        });
        notices.push(...page.notices);
        next.push(...page.next);
      }
    }
    return { notices, next };
  }

  async resolveUncertain(
    notice: Extract<ConversationStatusNotice, { state: "uncertain" }>,
    decision: "user-abandoned" | "user-verified-side-effects" | "user-retry-acknowledged",
  ): Promise<ConversationUncertainResolutionResult> {
    return this.#requestWithReconnect("session.resolve", {
      requestId: `resolve:${generateTurnId()}`,
      conversationId: notice.ref.conversationId,
      runId: notice.ref.runId,
      ownerEpoch: notice.ref.ownerEpoch,
      openFactDigest: notice.openFactDigest,
      decision,
    });
  }

  /**
   * 确认待审 Rubric 契约，并让宿主用原 turnId 开始执行原任务。
   * rubricDraftId 必填——「确认你所见」是协议边界：绑定发起端所见草案
   * 版本，草案被并发修订后宿主拒绝盲确认。
   */
  async confirmAdvancement(
    conversationId: string,
    advancementSessionId: string,
    rubricDraftId: string,
    rubricPersistence?: SessionRubricPersistenceChoice,
  ): Promise<SessionAdvancementConfirmResult> {
    return this.#advancementRequest<SessionAdvancementConfirmResult>("session.advancementConfirm", conversationId,
      { conversationId, advancementSessionId, rubricDraftId, ...(rubricPersistence ? { rubricPersistence } : {}) },
      result => {
        if ("status" in result || !result.runId) throw Error("任务确认状态已变化，请重新查看。");
        return { ...result, status: "confirmed", advancementSessionId, runStatus: "queued" };
      });
  }

  /**
   * 取消待审 Rubric 契约；executeOriginal=true 时降级为普通任务执行。
   */
  async cancelAdvancement(
    conversationId: string,
    advancementSessionId: string,
    opts: { executeOriginal?: boolean; rubricDraftId?: string } = {},
  ): Promise<SessionAdvancementCancelResult> {
    return this.#advancementRequest<SessionAdvancementCancelResult>("session.advancementCancel", conversationId,
      { conversationId, advancementSessionId, executeOriginal: opts.executeOriginal ?? false, ...(opts.rubricDraftId ? { rubricDraftId: opts.rubricDraftId } : {}) },
      result => {
        if ("status" in result && result.status === "cancelled") return { conversationId, sessionId: conversationId, status: "cancelled", advancementSessionId };
        if ("status" in result || !result.runId) throw Error("任务状态已变化，请重新查看。");
        return { ...result, status: "direct-execution", advancementSessionId, runStatus: "queued" };
      });
  }

  /** 按用户反馈修订待审 Rubric 草案，仍停留在确认控制面。 */
  async reviseAdvancement(
    conversationId: string,
    advancementSessionId: string,
    userFeedback: string,
    rubricDraftId?: string,
  ): Promise<SessionAdvancementReviseResult> {
    return this.#advancementRequest<SessionAdvancementReviseResult>("session.advancementRevise", conversationId,
      { conversationId, advancementSessionId, userFeedback, ...(rubricDraftId ? { rubricDraftId } : {}) },
      result => {
        if (!("status" in result) || result.status !== "awaiting-rubric-confirmation") throw Error("修订结果已核对，当前任务状态已变化，请重新查看。");
        return { conversationId, sessionId: conversationId, status: "revised", advancementSessionId: result.advancementSessionId,
          rubricDraftId: result.rubricDraftId, rubricDraft: result.rubricDraft };
      });
  }

  /** 建一个新对话(宿主写 meta + transcript 壳),返回身份供切指针。 */
  async newConversation(): Promise<SessionNewResult> {
    const client = await this.link.getClient();
    return client.request<SessionNewResult>("session.new", {
      ...this.#continuationConsent(),
    });
  }

  /** 清空对话(宿主先盘后窗;busy 时 BUSY 拒绝);断线以同一 requestId 重放。 */
  async clear(conversationId: string): Promise<void> {
    await this.#requestWithReconnect("session.clear", {
      conversationId,
      requestId: `clear:${generateTurnId()}`,
      ...this.#continuationConsent(),
    });
  }

  /** 手动压缩注意力窗口(宿主执行体)。 */
  async compact(conversationId: string): Promise<SessionCompactResult> {
    const client = await this.link.getClient();
    return client.request<SessionCompactResult>("session.compact", {
      conversationId,
      ...this.#continuationConsent(),
    });
  }

  /** /task new·done 的宿主执行体调用。 */
  async taskListUpdate(
    conversationId: string,
    action: SessionTaskListAction,
  ): Promise<SessionTaskListUpdateResult> {
    return this.#requestWithReconnect<SessionTaskListUpdateResult>(
      "session.taskListUpdate",
      {
        conversationId,
        action,
        requestId: `task-list:${generateTurnId()}`,
        ...this.#continuationConsent(),
      },
    );
  }

  /** task_list 宿主权威快照。 */
  async taskList(conversationId: string): Promise<SessionTaskListResult> {
    const client = await this.link.getClient();
    return client.request<SessionTaskListResult>("session.taskList", {
      conversationId,
    });
  }

  /** 当前注意力窗口的上下文预算(/usage /context 的数据面)。 */
  async contextBudget(
    conversationId: string,
  ): Promise<SessionContextBudgetResult> {
    const client = await this.link.getClient();
    return client.request<SessionContextBudgetResult>(
      "session.contextBudget",
      { conversationId },
    );
  }

  /** /usage 的完整宿主视图：上下文预算 + 子 agent/Task 用量拆分。 */
  async usage(conversationId: string): Promise<SessionUsageResult> {
    const client = await this.link.getClient();
    return client.request<SessionUsageResult>("session.usage", {
      conversationId,
    });
  }

  /** /advancement 的数据面：推进详情（归因展开 + 终态收场回看）。 */
  async advancementDetail(
    conversationId: string,
  ): Promise<SessionAdvancementDetailResult> {
    const client = await this.link.getClient();
    return client.request<SessionAdvancementDetailResult>(
      "session.advancementDetail",
      { conversationId },
    );
  }

  /** 切换到既有对话——宿主 touch + 返回 meta 与活跃态。 */
  async resume(conversationId: string): Promise<SessionResumeResult> {
    const client = await this.link.getClient();
    return client.request<SessionResumeResult>("session.resume", {
      conversationId,
      ...this.#continuationConsent(),
    });
  }

  async consumeReviseAdvancement<T>(conversationId: string, advancementSessionId: string, userFeedback: string, consume: (result: SessionAdvancementReviseResult) => T, rubricDraftId?: string): Promise<T> {

    return this.#advancementRequest<SessionAdvancementReviseResult, T>("session.advancementRevise", conversationId,
      { conversationId, advancementSessionId, userFeedback, ...(rubricDraftId ? { rubricDraftId } : {}) },
      result => {
        if (!("status" in result) || result.status !== "awaiting-rubric-confirmation") throw Error("修订结果已核对，当前任务状态已变化，请重新查看。");
        return { conversationId, sessionId: conversationId, status: "revised", advancementSessionId: result.advancementSessionId,
          rubricDraftId: result.rubricDraftId, rubricDraft: result.rubricDraft };
      }, consume);
  }

  async consumeResume<T>(conversationId: string, consume: (result: SessionResumeResult) => T): Promise<T> {
    const client = await this.link.getClient();
    const params = { conversationId, ...this.#continuationConsent() };
    return client.consume ? client.consume<SessionResumeResult, T>('session.resume', params, consume)
      : consume(await client.request<SessionResumeResult>('session.resume', params));
  }

  async consumeResumeIfExists<T>(conversationId: string, consume: (result: SessionResumeResult) => T): Promise<T | null> {
    try { return await this.consumeResume(conversationId, consume); }
    catch (error) { if (isRpcNotFound(error)) return null; throw error; }
  }

  /**
   * 尝试切换到既有对话。NOT_FOUND 是会话生命周期内的正常竞争结果
   * (多接入面删除 / 外部清理),在 facade 边界转为 null；其它错误保持异常,
   * 避免把宿主故障误判成"目标不存在"。
   */
  async resumeIfExists(
    conversationId: string,
  ): Promise<SessionResumeResult | null> {
    try {
      return await this.resume(conversationId);
    } catch (err) {
      if (isRpcNotFound(err)) return null;
      throw err;
    }
  }

  /** observer 登记(订阅即进组播名册);false = 对话身份不存在、未登记。 */
  async subscribe(
    conversationId: string,
    afterCommitRevision = 0,
    replayFinals?: boolean,
  ): Promise<boolean> {
    const client = await this.link.getClient();
    const result = await client.request<SessionSubscribeResult>('session.subscribe',
      { conversationId, afterCommitRevision, ...(replayFinals === undefined ? {} : { replayFinals }) });
    return result.subscribed;
  }

  async subscribePresentation(
    conversationId: string, presentation: import('@zhixing/rpc/session-wire').SessionPresentationProfile,
    afterCommitRevision = 0, replayFinals?: boolean,
  ): Promise<SessionSubscribeResult> {
    const client = await this.link.getClient();
    const result = await client.request<SessionSubscribeResult>(
      "session.subscribe",
      { conversationId, presentation, afterCommitRevision, ...(replayFinals === undefined ? {} : { replayFinals }) },
    );
    return result;
  }

  async controlPage(conversationId: string, cursor?: ConversationControlCursor, historyRunIds?: readonly string[]): Promise<ConversationControlPage> {
    const client = await this.link.getClient(), params = { mode: 'control-page', conversationId, cursor, ...(historyRunIds?.length ? { historyRunIds } : {}) };
    const consume = (page: ConversationControlPage): ConversationControlPage => boundedControlProjection({ ...page,
      facts: page.facts.map(fact => fact.kind === 'status' && 'reason' in fact.notice
        ? { ...fact, notice: { ...fact.notice, reason: fact.notice.reason?.slice(0, 2048) } } : fact),
    }, 512 * 1024);
    return client.consume ? client.consume('session.statusHistory', params, consume)
      : consume(await client.request<ConversationControlPage>('session.statusHistory', params));
  }
  async completion(conversationId: string, runId: string, ownerEpoch?: number): Promise<import('@zhixing/core/contracts').ConversationCompletionPage> {
    const client = await this.link.getClient();
    return boundedControlProjection(await client.request('session.statusHistory', { mode: 'completion', conversationId, runId, ownerEpoch }), 32 * 1024);
  }
  async bodyPage(conversationId: string, cursor?: import('@zhixing/core/contracts').ConversationBodyCursor,
    options: { direction?: 'forward' | 'reverse'; runId?: string } = {}): Promise<import('@zhixing/core/contracts').ConversationBodyPage> {
    const client = await this.link.getClient();
    const page = await client.request<import('@zhixing/core/contracts').ConversationBodyPage>('session.statusHistory', { mode: 'body-page', conversationId, ...(cursor ? { cursor } : {}), ...options });
    return boundedControlProjection(page, 224 * 1024);
  }

  async consumeInputPage<T>(conversationId: string, runId: string, cursor: ConversationInputCursor | undefined, consume: (page: ConversationInputPage) => Promise<T>): Promise<T> {
    const client = await this.link.getClient(), params = { mode: 'input-page', conversationId, runId, cursor };
    return client.consume ? client.consume('session.statusHistory', params, consume)
      : consume(await client.request<ConversationInputPage>('session.statusHistory', params));
  }

  async unsubscribe(conversationId: string): Promise<void> {
    const client = await this.link.getClient();
    await client.request("session.unsubscribe", { conversationId });
  }

  // ─── 通知还原(持久订阅,跨重连) ───

  onProcess(handler: (payload: import('@zhixing/rpc/session-wire').SessionProcessProjection) => void): () => void {
    return this.link.onNotification('session.process', payload => handler(payload as import('@zhixing/rpc/session-wire').SessionProcessProjection));
  }

  /** 主通道 turn 产出流(AgentYield 原样)——接入面还原为 onYield 喂主渲染。 */
  onDelta(handler: (payload: SessionDeltaPayload) => void): () => void {
    return this.link.onNotification(SESSION_NOTIFICATIONS.delta, (p) =>
      handler(p as SessionDeltaPayload),
    );
  }

  /** turn 落定(终止原因 + usage + wire 投影的 error)。 */
  onComplete(handler: (payload: SessionCompletePayload) => void): () => void {
    return this.link.onNotification(SESSION_NOTIFICATIONS.complete, (p) =>
      handler(p as SessionCompletePayload),
    );
  }

  onFinal(handler: (payload: FinalFrame) => void): () => void {
    return this.link.onNotification(SESSION_NOTIFICATIONS.final, (p) =>
      handler(p as FinalFrame),
    );
  }

  onStatus(handler: (payload: ConversationStatusNotice) => void): () => void {
    return this.link.onNotification(SESSION_NOTIFICATIONS.status, (p) =>
      handler(p as ConversationStatusNotice),
    );
  }

  /** S6 assignment 流的规范帧；与路径选择无关，跨重连保持同一 seq/摘要链。 */
  onAssignmentStream(handler: (payload: StreamFrame) => void): () => void {
    return this.link.onNotification(
      SESSION_NOTIFICATIONS.assignmentStream,
      (payload) => handler(payload as StreamFrame),
    );
  }

  /** 会话级变更(run 外发生:改名 / 删除)——旁观端据此刷新或退出视图。 */
  onChanged(handler: (payload: SessionChangedPayload) => void): () => void {
    return this.link.onNotification(SESSION_NOTIFICATIONS.changed, (p) =>
      handler(p as SessionChangedPayload),
    );
  }

  /** 非当前会话活动提示——不含内容,由接入面决定刷新列表或低噪提示。 */
  onActivity(handler: (payload: SessionActivityPayload) => void): () => void {
    return this.link.onNotification(SESSION_NOTIFICATIONS.activity, (p) =>
      handler(p as SessionActivityPayload),
    );
  }

  /**
   * turn 边界控制意图(仅发起连接可达,先于 complete 到达)——接入面暂存,
   * 收到对应 complete(turn 落定)即消费。
   */
  onPostTurnControlIntent(
    handler: (payload: SessionPostTurnControlIntentPayload) => void,
  ): () => void {
    return this.link.onNotification(
      SESSION_NOTIFICATIONS.postTurnControlIntent,
      (p) => handler(p as SessionPostTurnControlIntentPayload),
    );
  }
}

function isRpcNotFound(err: unknown): err is RpcClientError {
  return (
    err instanceof RpcClientError &&
    err.code === RPC_ERROR_CODES.NOT_FOUND
  );
}

function definitelyUnsubmitted(error: unknown): boolean {
  if (error instanceof RpcRequestInterruptedError && error.stage === 'before-send') return true;
  return error instanceof RpcClientError && [RPC_ERROR_CODES.PARSE_ERROR, RPC_ERROR_CODES.INVALID_REQUEST,
    RPC_ERROR_CODES.METHOD_NOT_FOUND, RPC_ERROR_CODES.UNAUTHORIZED].some(code => code === error.code);
}

function sameCapabilities(
  left: readonly string[] | null,
  right: readonly string[] | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.length === right.length &&
      left.every((capability, index) => capability === right[index]))
  );
}
