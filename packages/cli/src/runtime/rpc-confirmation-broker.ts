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

import type {
  ConfirmationDecision,
  ConfirmationRendererPort,
  ConfirmationRequest,
  RequestListener,
} from "@zhixing/core";
import { CONFIRMATION_NOTIFICATIONS } from "@zhixing/rpc";
import { RpcClientClosedError } from "@zhixing/server";
import type { CoreHostRpcLink } from "./core-host-connection.js";

export interface RpcConfirmationBrokerOptions {
  /** 进程级共享的核心宿主连接。 */
  link: CoreHostRpcLink;
  /** resolve 回程失败的上报(如面板提示"应答未送达")。 */
  onResolveError?: (error: unknown, requestId: string) => void;
}

export class RpcConfirmationBroker implements ConfirmationRendererPort {
  private readonly listeners = new Set<RequestListener>();
  private readonly unsubscribe: () => void;
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
    this.unsubscribe = opts.link.onNotification(
      CONFIRMATION_NOTIFICATIONS.pending,
      (params) => {
        if (this.disposed) return;
        const payload = params as {
          request?: ConfirmationRequest;
          conversationId?: string;
        };
        if (!payload.request) return;
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
        for (const listener of [...this.listeners]) {
          listener(payload.request);
        }
      },
    );
  }

  onRequest(listener: RequestListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  resolve(requestId: string, decision: ConfirmationDecision): boolean {
    if (this.disposed) return false;
    void this.resolveWithReconnect(requestId, decision).catch((err) =>
      this.opts.onResolveError?.(err, requestId),
    );
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
          await client.request("confirmation.resolve", params);
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
    this.unsubscribe();
    this.listeners.clear();
    this.pendingConversations.clear();
  }
}
