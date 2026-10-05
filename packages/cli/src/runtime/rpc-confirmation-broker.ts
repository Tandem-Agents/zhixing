/**
 * RpcConfirmationBroker —— cli 经 RPC 接入核心宿主确认链路的渲染端适配器。
 *
 * 实现 ConfirmationRendererPort(渲染器消费的 broker 窄面),终端确认面板
 * (TerminalConfirmationRenderer)零改挂接:
 * - 新请求:订阅 confirmation.pending 推送——可信连接(本机 cli)的 payload
 *   附完整 ConfirmationRequest 投影,面板按原生形态渲染(结构化 display /
 *   全选项含持久授权 pattern),能力零降级;无完整投影的 payload 不进面板
 *   (非可信投影,cli 必可信、此为防御分支)。
 * - 应答:resolve 走 confirmation.resolve RPC 回程,受理即真(boolean 同步
 *   契约)、实际落定异步完成;回程失败经 onResolveError 上报(cli 禁直写
 *   console,输出通道归装配方)。dispose 后本地拒绝迟到 resolve,不再连接
 *   宿主。宿主侧应答权与 decision 分级由方法层校验。
 *
 * 串行语义与本地 broker 对齐:宿主 broker 只对 showing 状态发通知,
 * 适配器原样转发、不自建队列。
 */

import type { ConfirmationDecision, ConfirmationRendererPort, ConfirmationRequest, RequestListener } from "@zhixing/core/confirmation";
import { CONFIRMATION_NOTIFICATIONS } from "@zhixing/rpc/confirmation-bridge";
import { RpcClientClosedError } from "@zhixing/server/client";
import type { CoreHostRpcLink } from "./core-host-connection.js";

export interface RpcConfirmationBrokerOptions {
  /** 进程级共享的核心宿主连接。 */
  link: CoreHostRpcLink;
  /** resolve 回程失败的上报(如面板提示"应答未送达")。 */
  onResolveError?: (error: unknown, requestId: string) => void;
}

export class RpcConfirmationBroker implements ConfirmationRendererPort {
  private readonly listeners = new Set<RequestListener>();
  private readonly invalidatedListeners = new Set<(requestId: string) => void>();
  private readonly resolving = new Set<string>();
  private readonly retired = new Set<string>();
  private generation = 0;
  private refreshSequence = 0;
  private eventRevision = 0;
  private readonly unsubscribes: readonly (() => void)[];
  private readonly visible = new Set<string>();
  /**
   * requestId → conversationId,取自 pending 推送:重试携带它让宿主在
   * entry 已出索引(丢响应/重启)时按耐久 interaction outcome 回放原结果。
   * 生命周期:resolve 收敛即清、dispose 清空;用户未应答而过期的确认不再有
   * 清理事件,以 FIFO 上限驱逐兜底——被驱逐的极端迟到重试降级为 not-found,
   * 方向安全(零第二次生效不受影响)。
   */
  private readonly pendingConversations = new Map<string, string>();
  private static readonly MAX_PENDING_CONVERSATIONS = 128;
  private disposed = false;

  constructor(private readonly opts: RpcConfirmationBrokerOptions) {
    this.unsubscribes = [
      opts.link.onNotification(
        CONFIRMATION_NOTIFICATIONS.pending,
        (params) => { this.eventRevision++; this.acceptPending(params); },
      ),
      opts.link.onNotification(
        CONFIRMATION_NOTIFICATIONS.resolved,
        (params) => {
          const requestId = (params as { requestId?: unknown }).requestId;
          if (typeof requestId !== "string") return;
          this.eventRevision++;
          this.retire(requestId);
        },
      ),
      ...(opts.link.onDisconnect ? [opts.link.onDisconnect(() => {
        this.generation++;
        this.invalidateAll();
        this.retired.clear();
      })] : []),
    ];
  }

  /** Replays pending requests after a missed notification or host reconnect. */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    const generation = this.generation;
    const sequence = ++this.refreshSequence;
    const revision = this.eventRevision;
    const client = await this.opts.link.getClient();
    if (this.disposed || generation !== this.generation || sequence !== this.refreshSequence) return;
    type List = { readonly items: readonly { readonly conversationId?: string; readonly request?: ConfirmationRequest }[] };
    const consume = (result: List): void => {
      // 旧连接/旧请求/在途通知之前的快照不能重新打开旧面板。
      if (this.disposed || client.closed || generation !== this.generation ||
          sequence !== this.refreshSequence || revision !== this.eventRevision) return;
      const pending = new Set<string>();
      for (const item of result.items) {
        if (!item.request) continue;
        if (pending.size >= RpcConfirmationBroker.MAX_PENDING_CONVERSATIONS || item.request.id.length > 512) throw Error('confirmation identity capacity');
        pending.add(item.request.id);
      }
      for (const id of [...this.visible]) if (!pending.has(id)) this.retire(id);
      for (const item of result.items) this.acceptPending(item);
    };
    if (client.consume) await client.consume<List, void>('confirmation.list', undefined, consume);
    else consume(await client.request<List>('confirmation.list'));
  }

  onInvalidated(listener: (requestId: string) => void): () => void {
    this.invalidatedListeners.add(listener);
    return () => { this.invalidatedListeners.delete(listener); };
  }

  /** Fetch a deferred panel from the authority; queued surfaces retain identity
   * only, rather than holding every request body during another page. */
  async readPending<T = ConfirmationRequest>(requestId: string,
    project: (request: ConfirmationRequest) => T = request => request as T): Promise<T | undefined> {
    if (this.disposed || !this.visible.has(requestId)) return;
    const generation = this.generation;
    const client = await this.opts.link.getClient();
    type List = { readonly items: readonly { readonly request?: ConfirmationRequest }[] };
    const consume = (result: List): T | undefined => {
      if (this.disposed || client.closed || generation !== this.generation || !this.visible.has(requestId)) return;
      const request = result.items.find(item => item.request?.id === requestId)?.request;
      return request ? project(request) : undefined;
    };
    return client.consume ? client.consume<List, T | undefined>('confirmation.list', undefined, consume)
      : consume(await client.request<List>('confirmation.list'));
  }

  private invalidate(requestId: string): void {
    const wasVisible = this.visible.delete(requestId);
    this.pendingConversations.delete(requestId);
    if (wasVisible) for (const listener of [...this.invalidatedListeners]) listener(requestId);
  }

  private invalidateAll(): void {
    for (const id of [...this.visible]) this.invalidate(id);
  }

  private retire(requestId: string): void {
    this.retired.add(requestId);
    if (this.retired.size > RpcConfirmationBroker.MAX_PENDING_CONVERSATIONS) {
      this.retired.delete(this.retired.values().next().value!);
    }
    this.invalidate(requestId);
  }

  onRequest(listener: RequestListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  resolve(requestId: string, decision: ConfirmationDecision): boolean {
    if (this.disposed || !this.visible.has(requestId) || this.resolving.has(requestId)) return false;
    this.resolving.add(requestId);
    // 在任何失效通知/await 前捕获完整决定与耐久定位；之后的断线只关闭展示。
    const pending = this.resolveWithReconnect(requestId, structuredClone(decision));
    this.invalidate(requestId);
    void pending.then(() => this.retire(requestId)).catch((err) => {
      this.resolving.delete(requestId);
      this.opts.onResolveError?.(err, requestId);
      void this.refresh().catch(() => {});
    }).finally(() => { this.resolving.delete(requestId); });
    return true;
  }

  /**
   * 断线以同一 requestId+decision 重放:服务端对已耐久 outcome 回放原结果
   * (同一完整决定成功、任一字段不同则稳定冲突),重试不产生第二次生效。conversationId
   * 供宿主在 entry 已出索引(含重启)时定位耐久 interaction outcome。
   */
  private async resolveWithReconnect(
    requestId: string,
    decision: ConfirmationDecision,
  ): Promise<void> {
    const conversationId = this.pendingConversations.get(requestId);
    const params = {
      requestId,
      decision,
      ...(conversationId ? { conversationId } : {}),
    };
    try {
      while (!this.disposed) {
        const client = await this.opts.link.getClient();
        try {
          const result = await client.request<{ readonly ok: boolean; readonly reason?: string }>("confirmation.resolve", params);
          if (result?.ok !== true) {
            const message = result?.reason === "decision-conflict"
              ? "此确认已有不同的决定，宿主未接受此次应答。"
              : result?.reason === "already-resolved-or-not-found"
                ? "此确认已处理或已失效，宿主未接受此次应答。"
                : "未取得有效的确认应答回执，请核对当前请求状态。";
            throw new Error(message);
          }
          return;
        } catch (error) {
          if (!(error instanceof RpcClientClosedError)) throw error;
        }
      }
    } finally {
      this.pendingConversations.delete(requestId);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.invalidateAll();
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.listeners.clear();
    this.invalidatedListeners.clear();
    this.pendingConversations.clear();
    this.visible.clear();
    this.retired.clear();
  }

  private acceptPending(params: unknown): void {
    if (this.disposed) return;
    const payload = params as {
      request?: ConfirmationRequest;
      conversationId?: string;
    };
    if (!payload.request || this.visible.has(payload.request.id) || this.resolving.has(payload.request.id) || this.retired.has(payload.request.id)) return;
    if (payload.request.id.length > 512 || (payload.conversationId?.length ?? 0) > 512 ||
      this.visible.size >= RpcConfirmationBroker.MAX_PENDING_CONVERSATIONS) throw Error('confirmation identity capacity');
    this.visible.add(payload.request.id);
    if (payload.conversationId) {
      if (
        this.pendingConversations.size >=
        RpcConfirmationBroker.MAX_PENDING_CONVERSATIONS
      ) {
        const oldest = this.pendingConversations.keys().next().value;
        if (oldest !== undefined) this.pendingConversations.delete(oldest);
      }
      this.pendingConversations.set(payload.request.id, payload.conversationId);
    }
    for (const listener of [...this.listeners]) listener(payload.request);
  }
}
