/**
 * RpcConversationFacade —— cli 经 RPC 接入核心宿主的会话域方法门面。
 *
 * 对标 RpcSchedulerFacade:facade 是方法域封装、不持连接——连接是进程级
 * 共享的 CoreHostLink(调度 / 会话 / 确认域共用一条已认证连接),建立 /
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
  RunsPage,
  RunsPageCursor,
} from "@zhixing/server";
import type {
  SessionChangedPayload,
  SessionActivityPayload,
  SessionAdvancementCancelResult,
  SessionAdvancementConfirmResult,
  SessionAdvancementReviseResult,
  SessionCompactResult,
  SessionContextBudgetResult,
  SessionCompletePayload,
  SessionConversationEntry,
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
import { generateTurnId, type UserTurnInput } from "@zhixing/core";
import type {
  ConversationStatusNotice,
  FinalFrame,
} from "@zhixing/core/contracts";
import {
  RpcClientError,
  RpcClientClosedError,
  RPC_ERROR_CODES,
} from "@zhixing/server";
import { SESSION_NOTIFICATIONS } from "@zhixing/rpc";
import type { CoreHostLink } from "./core-host-connection.js";

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

export class RpcConversationFacade {
  constructor(private readonly link: CoreHostLink) {}

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
    return this.#requestWithReconnect<SessionSendResult>("session.send", {
      ...(typeof input === "string" ? { text: input } : { input }),
      conversationId,
      turnId,
      surfaceCapabilities: { postTurnControl: true },
      ...(options.engage ? { engage: options.engage } : {}),
    });
  }

  /** 对话列表——盘上全量叠加活跃态(/resume 候选源)。 */
  async list(): Promise<SessionConversationEntry[]> {
    const client = await this.link.getClient();
    const result = await client.request<SessionListResult>("session.list");
    return result.conversations;
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

  /** 对话改名;返回的 conversationId 保持入参全域键。 */
  async rename(conversationId: string, name: string): Promise<SessionRenameResult> {
    const client = await this.link.getClient();
    return client.request<SessionRenameResult>("session.rename", {
      conversationId,
      name,
    });
  }

  /** 删除对话(活跃运行时释放 + 落盘数据删除);断线以同一 requestId 重放。 */
  async delete(conversationId: string): Promise<void> {
    await this.#requestWithReconnect("session.delete", {
      conversationId,
      requestId: `delete:${generateTurnId()}`,
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
    });
  }

  async statusHistory(
    cursors: readonly ConversationStatusCursor[],
  ): Promise<{
    readonly notices: readonly ConversationStatusNotice[];
    readonly next: readonly ConversationStatusCursor[];
  }> {
    const client = await this.link.getClient();
    const result = await client.request<{
      readonly conversationStatus: readonly ConversationStatusNotice[];
      readonly conversationStatusNext: readonly ConversationStatusCursor[];
    }>("server.info", { conversationStatusAfter: cursors });
    return {
      notices: result.conversationStatus,
      next: result.conversationStatusNext,
    };
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
    const client = await this.link.getClient();
    return client.request<SessionAdvancementConfirmResult>(
      "session.advancementConfirm",
      {
        conversationId,
        advancementSessionId,
        rubricDraftId,
        ...(rubricPersistence ? { rubricPersistence } : {}),
      },
    );
  }

  /**
   * 取消待审 Rubric 契约；executeOriginal=true 时降级为普通任务执行。
   */
  async cancelAdvancement(
    conversationId: string,
    advancementSessionId: string,
    opts: { executeOriginal?: boolean } = {},
  ): Promise<SessionAdvancementCancelResult> {
    const client = await this.link.getClient();
    return client.request<SessionAdvancementCancelResult>(
      "session.advancementCancel",
      {
        conversationId,
        advancementSessionId,
        executeOriginal: opts.executeOriginal ?? false,
      },
    );
  }

  /** 按用户反馈修订待审 Rubric 草案，仍停留在确认控制面。 */
  async reviseAdvancement(
    conversationId: string,
    advancementSessionId: string,
    userFeedback: string,
  ): Promise<SessionAdvancementReviseResult> {
    const client = await this.link.getClient();
    return client.request<SessionAdvancementReviseResult>(
      "session.advancementRevise",
      { conversationId, advancementSessionId, userFeedback },
    );
  }

  /** 建一个新对话(宿主写 meta + transcript 壳),返回身份供切指针。 */
  async newConversation(): Promise<SessionNewResult> {
    const client = await this.link.getClient();
    return client.request<SessionNewResult>("session.new");
  }

  /** 清空对话(宿主先盘后窗;busy 时 BUSY 拒绝);断线以同一 requestId 重放。 */
  async clear(conversationId: string): Promise<void> {
    await this.#requestWithReconnect("session.clear", {
      conversationId,
      requestId: `clear:${generateTurnId()}`,
    });
  }

  /** 手动压缩注意力窗口(宿主执行体)。 */
  async compact(conversationId: string): Promise<SessionCompactResult> {
    const client = await this.link.getClient();
    return client.request<SessionCompactResult>("session.compact", {
      conversationId,
    });
  }

  /** /task new·done 的宿主执行体调用。 */
  async taskListUpdate(
    conversationId: string,
    action: SessionTaskListAction,
  ): Promise<SessionTaskListUpdateResult> {
    const client = await this.link.getClient();
    return client.request<SessionTaskListUpdateResult>(
      "session.taskListUpdate",
      { conversationId, action },
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
    });
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
  async subscribe(conversationId: string): Promise<boolean> {
    const client = await this.link.getClient();
    const result = await client.request<SessionSubscribeResult>(
      "session.subscribe",
      { conversationId },
    );
    return result.subscribed;
  }

  async unsubscribe(conversationId: string): Promise<void> {
    const client = await this.link.getClient();
    await client.request("session.unsubscribe", { conversationId });
  }

  // ─── 通知还原(持久订阅,跨重连) ───

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
