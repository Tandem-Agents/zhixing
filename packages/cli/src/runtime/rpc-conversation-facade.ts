/**
 * RpcConversationFacade —— cli 经 RPC 接入核心宿主的会话域方法门面。
 *
 * 对标 RpcSchedulerFacade:facade 是方法域封装、不持连接——连接是进程级
 * 共享的 CoreHostLink(调度 / 会话 / 确认域共用一条已认证连接),建立 /
 * 重连 / 释放归连接持有者。
 *
 * 方法调用按需 ensure 宿主;通知订阅(onDelta / onComplete / onChanged /
 * onModeSwitchIntent)走连接的持久订阅——跨重连有效且被动,不为订阅拉起
 * 宿主。payload 类型取自 server 的 wire 契约单源,两侧不各自手写镜像。
 *
 * handler 收到的 payload 含 conversationId——"当前对话"是接入面 UI 态,
 * 过滤归调用方,facade 对此零知识。
 */

import type {
  RunsPage,
  RunsPageCursor,
  SessionChangedPayload,
  SessionCompactResult,
  SessionContextBudgetResult,
  SessionCompletePayload,
  SessionConversationEntry,
  SessionDeltaPayload,
  SessionListResult,
  SessionModeSwitchIntentPayload,
  SessionNewResult,
  SessionRenameResult,
  SessionResumeResult,
  SessionSendResult,
  SessionSubscribeResult,
  SessionTaskListAction,
  SessionTaskListResult,
  SessionTaskListUpdateResult,
} from "@zhixing/server";
import {
  RpcClientError,
  RPC_ERROR_CODES,
  SESSION_NOTIFICATIONS,
} from "@zhixing/server";
import type { CoreHostLink } from "./core-host-connection.js";

export interface SessionHistoryOptions {
  /** 单页 run 数上限(宿主默认 20、上限 200) */
  limit?: number;
  /** 倒读分页游标——续读上一页末条之前的内容 */
  before?: RunsPageCursor;
}

export class RpcConversationFacade {
  constructor(private readonly link: CoreHostLink) {}

  // ─── 方法域 ───

  /** 发送一个 turn(经宿主唯一串行点入队);turnId 由发起端预分配以闭合通知竞态。 */
  async send(
    text: string,
    conversationId?: string,
    turnId?: string,
  ): Promise<SessionSendResult> {
    const client = await this.link.getClient();
    return client.request<SessionSendResult>("session.send", {
      text,
      conversationId,
      turnId,
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

  /** 删除对话(活跃运行时释放 + 落盘数据删除)。 */
  async delete(conversationId: string): Promise<void> {
    const client = await this.link.getClient();
    await client.request("session.delete", { conversationId });
  }

  /** 中止当前 in-flight turn / 撤回排队项。 */
  async abort(conversationId: string): Promise<void> {
    const client = await this.link.getClient();
    await client.request("session.abort", { conversationId });
  }

  /** 建一个新对话(宿主写 meta + transcript 壳),返回身份供切指针。 */
  async newConversation(): Promise<SessionNewResult> {
    const client = await this.link.getClient();
    return client.request<SessionNewResult>("session.new");
  }

  /** 清空对话(宿主先盘后窗;busy 时 BUSY 拒绝)。 */
  async clear(conversationId: string): Promise<void> {
    const client = await this.link.getClient();
    await client.request("session.clear", { conversationId });
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

  /** 会话级变更(run 外发生:改名 / 删除)——旁观端据此刷新或退出视图。 */
  onChanged(handler: (payload: SessionChangedPayload) => void): () => void {
    return this.link.onNotification(SESSION_NOTIFICATIONS.changed, (p) =>
      handler(p as SessionChangedPayload),
    );
  }

  /**
   * 模式切换意图(仅发起连接可达,先于 complete 到达)——接入面暂存,
   * 收到对应 complete(turn 落定)即消费,与 REPL 的 turn 边界消费语义对齐。
   */
  onModeSwitchIntent(
    handler: (payload: SessionModeSwitchIntentPayload) => void,
  ): () => void {
    return this.link.onNotification(SESSION_NOTIFICATIONS.modeSwitchIntent, (p) =>
      handler(p as SessionModeSwitchIntentPayload),
    );
  }
}

function isRpcNotFound(err: unknown): err is RpcClientError {
  return (
    err instanceof RpcClientError &&
    err.code === RPC_ERROR_CODES.NOT_FOUND
  );
}
