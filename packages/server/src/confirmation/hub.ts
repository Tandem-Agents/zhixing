/**
 * ConfirmationHub —— 聚合 per-runtime broker 的 server 级 facade
 *
 * 背景（[remote-confirmation-execution.md §3.2]）：
 * `AgentRuntime` 每次创建都 `new ConfirmationBroker()`——server 中存在 N+1 个
 * broker（N 个 conversation 各一个 + 1 个 ephemeralRuntime）。Hub 不替换 broker，
 * 而是聚合所有 broker 的事件，对外提供统一的查询 / 解决 / 反查接口。
 *
 * 职责：
 *   1. `attach(brokerId, broker, opts?)` —— 注册一个 broker，订阅其 request/resolved 事件
 *   2. `detach(brokerId)` —— 注销（detach 顺序：先 cancelAll → 取消订阅 → 清索引）
 *   3. `onEvent(listener)` —— Renderer / Bridge 订阅聚合事件流
 *   4. `resolve(requestId, decision)` —— 跨 broker 按 requestId 路由解决
 *   5. `findBrokerByConversation(conversationId)` —— 反查（InboundRouter 热路径）
 *   6. `listAllPending()` —— 聚合所有 broker 的 pending 列表
 *
 * 不变量（INV-H1 / H2 / H3）：
 *   - **INV-H1**：同一 conversationId 至多 attach 一个 broker（`conversationIndex` 唯一约束）
 *   - **INV-H2**：brokerId 全局唯一（`attach` 重复抛错）
 *   - **INV-H3**：detach 顺序"cancelAll → 取消订阅 → 清索引"——保证 pending 的
 *     resolved 事件能到达 Hub listener 后再清理，防止客户端 UI 卡在"待确认"
 */

import type {
  CancelCause,
  ConfirmationDecision,
  ConfirmationRequest,
  ConfirmationRequestId,
  IConfirmationBroker,
} from "@zhixing/core";

// ─── 类型 ───

export type BrokerId = string;

/** Hub 聚合事件的统一入口条目——带 brokerId + conversationId（可选）元数据 */
export interface HubEntry {
  readonly request: ConfirmationRequest;
  readonly brokerId: BrokerId;
  readonly conversationId?: string;
}

/** Hub 对外的事件流（判别式联合） */
export type HubEvent =
  | { type: "request"; entry: HubEntry }
  | {
      type: "resolved";
      requestId: ConfirmationRequestId;
      brokerId: BrokerId;
      conversationId?: string;
      decision: ConfirmationDecision;
    };

/** 用于取消订阅 */
export type HubUnsubscribe = () => void;

/** Hub 内部保存的 broker 注册项 */
interface BrokerRegistration {
  readonly brokerId: BrokerId;
  readonly broker: IConfirmationBroker;
  readonly conversationId?: string;
  readonly unsubscribeOnRequest: () => void;
  readonly unsubscribeOnResolved: () => void;
}

// ─── Hub ───

export class ConfirmationHub {
  private readonly brokers = new Map<BrokerId, BrokerRegistration>();
  private readonly requestIndex = new Map<ConfirmationRequestId, BrokerId>();
  /** conversationId → brokerId 反向索引，InboundRouter pending-aware 拦截的 O(1) 路径 */
  private readonly conversationIndex = new Map<string, BrokerId>();
  private readonly listeners = new Set<(event: HubEvent) => void>();

  /**
   * 注册一个 broker。
   *
   * @throws {Error} 当 brokerId 已存在（INV-H2）或 conversationId 已被其它 broker
   *                 占用（INV-H1）。这两个都是**运行时编程错误**——生产里不应触发。
   */
  attach(
    brokerId: BrokerId,
    broker: IConfirmationBroker,
    opts?: { conversationId?: string },
  ): void {
    if (this.brokers.has(brokerId)) {
      throw new Error(
        `ConfirmationHub: broker "${brokerId}" already attached (INV-H2)`,
      );
    }
    const convId = opts?.conversationId;
    if (convId && this.conversationIndex.has(convId)) {
      throw new Error(
        `ConfirmationHub: conversation "${convId}" already has attached broker (INV-H1)`,
      );
    }

    const unsubReq = broker.onRequest((request) => {
      this.requestIndex.set(request.id, brokerId);
      this.emit({
        type: "request",
        entry: { request, brokerId, conversationId: convId },
      });
    });

    const unsubRes = broker.onResolved((requestId, decision) => {
      this.requestIndex.delete(requestId);
      this.emit({
        type: "resolved",
        requestId,
        brokerId,
        conversationId: convId,
        decision,
      });
    });

    this.brokers.set(brokerId, {
      brokerId,
      broker,
      conversationId: convId,
      unsubscribeOnRequest: unsubReq,
      unsubscribeOnResolved: unsubRes,
    });
    if (convId) this.conversationIndex.set(convId, brokerId);
  }

  /**
   * 注销一个 broker。
   *
   * 顺序（INV-H3）：
   *   1. `cancelPending=true`（默认）时先 `broker.cancelAll(cause)` ——触发所有
   *      pending 的 resolved 事件经 Hub.onEvent 到达 Renderer/Bridge，防止客户端
   *      UI 卡在"待确认"
   *   2. 取消 onRequest / onResolved 订阅
   *   3. 清理 requestIndex / conversationIndex
   *   4. 从 brokers 移除
   *
   * 幂等：对已注销的 brokerId 调用 detach 是 no-op。
   */
  detach(
    brokerId: BrokerId,
    opts?: { cancelPending?: boolean; cause?: CancelCause },
  ): void {
    const reg = this.brokers.get(brokerId);
    if (!reg) return;

    if (opts?.cancelPending ?? true) {
      reg.broker.cancelAll(opts?.cause ?? "session-end");
    }

    reg.unsubscribeOnRequest();
    reg.unsubscribeOnResolved();

    // 清理 requestIndex 里属于此 broker 的条目
    for (const [reqId, bId] of this.requestIndex) {
      if (bId === brokerId) this.requestIndex.delete(reqId);
    }
    if (reg.conversationId) this.conversationIndex.delete(reg.conversationId);
    this.brokers.delete(brokerId);
  }

  /** 聚合所有 broker 的 pending 列表（带元数据） */
  listAllPending(): HubEntry[] {
    const out: HubEntry[] = [];
    for (const reg of this.brokers.values()) {
      for (const p of reg.broker.listPending()) {
        out.push({
          request: p.request,
          brokerId: reg.brokerId,
          conversationId: reg.conversationId,
        });
      }
    }
    return out;
  }

  /**
   * 跨 broker 按 requestId 路由解决请求。
   *
   * 使用场景：Web UI / RPC 客户端通过 `confirmation.resolve` 解决任意会话的请求——
   * 只知道 requestId、不知道 brokerId。
   *
   * @returns broker.resolve 的返回值；未找到 requestId 时返 false
   */
  resolve(
    requestId: ConfirmationRequestId,
    decision: ConfirmationDecision,
  ): boolean {
    const brokerId = this.requestIndex.get(requestId);
    if (!brokerId) return false;
    const reg = this.brokers.get(brokerId);
    if (!reg) return false;
    return reg.broker.resolve(requestId, decision);
  }

  /**
   * O(1) 按 conversationId 反查 broker。
   *
   * **热路径**：InboundRouter 每条入站通道消息都调用以判断是否是确认回复。
   * 依赖 INV-H1 保证每个 conversationId 至多一个 broker。
   */
  findBrokerByConversation(
    conversationId: string,
  ): IConfirmationBroker | undefined {
    const brokerId = this.conversationIndex.get(conversationId);
    if (!brokerId) return undefined;
    return this.brokers.get(brokerId)?.broker;
  }

  /**
   * O(1) 按 requestId 反查 HubEntry——用于权限校验。
   *
   * 调用方典型使用模式（`confirmation.resolve` RPC handler）：
   *   ```
   *   const entry = hub.findEntry(requestId);
   *   if (!entry) return { ok: false };
   *   if (entry.conversationId) {
   *     if (!observerIds.has(callerId)) throw unauthorized;
   *   } else {
   *     // ephemeral（无 conversationId）→ 仅 admin 可解决
   *   }
   *   ```
   *
   * 只返回仍在 pending 的请求；已 resolved 的 requestId 返回 undefined
   * （requestIndex 在 resolved 时被清理）。
   */
  findEntry(requestId: ConfirmationRequestId): HubEntry | undefined {
    const brokerId = this.requestIndex.get(requestId);
    if (!brokerId) return undefined;
    const reg = this.brokers.get(brokerId);
    if (!reg) return undefined;
    // 从 broker.listPending 找到对应条目
    const pending = reg.broker
      .listPending()
      .find((p) => p.request.id === requestId);
    if (!pending) return undefined;
    return {
      request: pending.request,
      brokerId: reg.brokerId,
      conversationId: reg.conversationId,
    };
  }

  /**
   * 订阅 Hub 的聚合事件流（request + resolved）。
   *
   * 使用场景：
   *   - TextConfirmationRenderer 订阅 request 事件发通道消息
   *   - ConfirmationBridge 订阅 request + resolved 事件推 RPC 通知
   *
   * @returns unsubscribe 函数
   */
  onEvent(listener: (event: HubEvent) => void): HubUnsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 快照：用于调试 / 状态查询 */
  snapshot(): {
    brokers: Array<{ brokerId: BrokerId; conversationId?: string; pendingCount: number }>;
    requestIndexSize: number;
    conversationIndexSize: number;
    listenerCount: number;
  } {
    return {
      brokers: [...this.brokers.values()].map((r) => ({
        brokerId: r.brokerId,
        conversationId: r.conversationId,
        pendingCount: r.broker.listPending().length,
      })),
      requestIndexSize: this.requestIndex.size,
      conversationIndexSize: this.conversationIndex.size,
      listenerCount: this.listeners.size,
    };
  }

  // ─── 内部 ───

  private emit(event: HubEvent): void {
    // snapshot 遍历，避免 listener 内 subscribe/unsubscribe 导致索引错乱
    const snapshot = [...this.listeners];
    for (const fn of snapshot) {
      try {
        fn(event);
      } catch (err) {
        // listener 错误不影响 Hub 主流程
        console.error("[ConfirmationHub] listener threw", err);
      }
    }
  }
}
