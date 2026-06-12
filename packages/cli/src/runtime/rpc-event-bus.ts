/**
 * RpcEventBus —— 带外通道(session.event)的接入面还原器。
 *
 * 宿主侧 per-run bus 经转发装饰器投影为统一信封(SessionEventEnvelope)组播,
 * 本适配器把信封还原为渲染层所需的 bus 形接口(IEventBus<AgentEventMap>),
 * createRenderSubscribers / status-bar 订阅零改:
 *
 * - 以 agent:run_start / agent:run_end 为边界建立 / 拆除 per-run 投影 bus,
 *   建立时调用注入的装饰钩子(与本地 runtime 的 decorateRunBus 同形)挂渲染
 *   订阅,拆除时 dispose——per-run 装饰生命周期与本地路径完全同构;
 * - 中途加入(turn 进行中订阅,错过 run_start)从当前帧起隐式建立投影;
 *   孤立 run_end(无投影在场)直接丢弃——本端没看过该 run 的任何帧;
 * - meta.lineage 从信封透传(渲染层区分子 agent 帧依赖它),不取本地身份;
 * - 同一对话同时至多一个 run(宿主唯一串行点保证)——投影按 conversationId
 *   单槽索引,新 runId 帧到达即拆旧建新(run_end 丢失时的兜底回收);
 * - seq 单调守卫:重复 / 乱序帧丢弃(协议级防御,WS 单连接内本就有序)。
 *
 * 订阅经连接的持久订阅(跨重连有效、被动——不为订阅拉起宿主)。"当前对话"
 * 是接入面 UI 态,经 filter 注入——适配器自身不持有它。
 */

import type {
  AgentEventMap,
  EventMeta,
  IEventBus,
  Listener,
  TurnContext,
  Unsubscribe,
  WildcardListener,
} from "@zhixing/core";
import type { DecorateRunBusFn } from "@zhixing/orchestrator";
import { SESSION_NOTIFICATIONS, type SessionEventEnvelope } from "@zhixing/server";
import type { CoreHostLink } from "./core-host-connection.js";

const RUN_END_EVENT = "agent:run_end";

export interface RpcEventBusOptions {
  /** 进程级共享的核心宿主连接。 */
  link: CoreHostLink;
  /** per-run 装饰钩子(渲染订阅挂载)——与本地 runtime 的 decorateRunBus 同形。 */
  decorate: DecorateRunBusFn;
  /**
   * 信封级过滤(如"只投当前对话")。返回 false 的信封不进投影。
   * 缺省全收。
   */
  filter?: (envelope: SessionEventEnvelope) => boolean;
  /**
   * 订阅者 / 装饰器收尾的错误上报(错误隔离,单个 listener 抛错不打断分发)。
   * cli 禁直写 console,输出通道由装配方决定。
   */
  onListenerError: (error: unknown, event: string) => void;
}

interface ProjectionEntry {
  runId: string;
  bus: ProjectionBus;
  dispose: () => void;
  lastSeq: number;
}

export class RpcEventBus {
  private readonly projections = new Map<string, ProjectionEntry>();
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(private readonly opts: RpcEventBusOptions) {
    this.unsubscribe = opts.link.onNotification(
      SESSION_NOTIFICATIONS.event,
      (params) => this.handleEnvelope(params as SessionEventEnvelope),
    );
  }

  private handleEnvelope(envelope: SessionEventEnvelope): void {
    if (this.disposed) return;
    if (this.opts.filter && !this.opts.filter(envelope)) return;

    const current = this.projections.get(envelope.conversationId);

    if (current && current.runId === envelope.runId) {
      if (envelope.seq <= current.lastSeq) return;
      current.lastSeq = envelope.seq;
      this.dispatchTo(current, envelope);
      if (envelope.event === RUN_END_EVENT) {
        this.teardown(envelope.conversationId);
      }
      return;
    }

    // 新 runId 的帧:同会话串行,新 run 出现即旧 run 已结束——拆旧建新
    if (current) this.teardown(envelope.conversationId);

    // 孤立 run_end(本端无投影在场):没看过该 run 的任何帧,建了即拆无意义
    if (envelope.event === RUN_END_EVENT) return;

    const entry = this.establish(envelope);
    this.projections.set(envelope.conversationId, entry);
    this.dispatchTo(entry, envelope);
  }

  /** 建立 per-run 投影:run_start 帧走此,中途加入的任意帧也走此(隐式建立) */
  private establish(envelope: SessionEventEnvelope): ProjectionEntry {
    const bus = new ProjectionBus(this.opts.onListenerError);
    const turnContext: TurnContext = {
      turnId: envelope.runId || undefined,
      turnOrigin: envelope.meta.turnOrigin,
    };
    const dispose = this.opts.decorate({
      bus,
      conversationId: envelope.conversationId,
      turnContext,
    });
    return { runId: envelope.runId, bus, dispose, lastSeq: envelope.seq };
  }

  private dispatchTo(entry: ProjectionEntry, envelope: SessionEventEnvelope): void {
    entry.bus.dispatchWire(envelope.event, envelope.payload, {
      lineage: envelope.meta.lineage,
    });
  }

  private teardown(conversationId: string): void {
    const entry = this.projections.get(conversationId);
    if (!entry) return;
    this.projections.delete(conversationId);
    try {
      entry.dispose();
    } catch (err) {
      this.opts.onListenerError(err, "decorate:dispose");
    }
    entry.bus.removeAllListeners();
  }

  /** 退订连接通知并拆除全部活跃投影。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    for (const conversationId of [...this.projections.keys()]) {
      this.teardown(conversationId);
    }
  }
}

// ─── per-run 投影 bus ───

/**
 * IEventBus<AgentEventMap> 的投影实现——事件由 wire 信封重放驱动
 * (dispatchWire,meta 携带信封透传的 lineage),订阅面与本地 bus 等价。
 *
 * 不用 core 的 EventBus:它的 emit 把 meta.lineage 钉死为 bus 自身身份,
 * 而投影必须还原"最初 emit 的 bus"的 lineage——meta 可注入是此实现存在的
 * 全部理由。错误隔离语义与 core EventBus 一致(单 listener 抛错不打断分发)。
 */
class ProjectionBus implements IEventBus<AgentEventMap> {
  readonly lineage: string | undefined = undefined;
  private readonly listeners = new Map<string, Set<Listener<never>>>();
  private readonly wildcards = new Set<WildcardListener<AgentEventMap>>();

  constructor(
    private readonly onListenerError: (error: unknown, event: string) => void,
  ) {}

  on<K extends keyof AgentEventMap & string>(
    event: K,
    listener: Listener<AgentEventMap[K]>,
  ): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  once<K extends keyof AgentEventMap & string>(
    event: K,
    listener: Listener<AgentEventMap[K]>,
  ): Unsubscribe {
    const wrapped: Listener<AgentEventMap[K]> = (payload, meta) => {
      this.off(event, wrapped);
      return listener(payload, meta);
    };
    return this.on(event, wrapped);
  }

  off<K extends keyof AgentEventMap & string>(
    event: K,
    listener: Listener<AgentEventMap[K]>,
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(listener as Listener<never>);
    if (set.size === 0) this.listeners.delete(event);
  }

  onAny(listener: WildcardListener<AgentEventMap>): Unsubscribe {
    this.wildcards.add(listener);
    return () => {
      this.wildcards.delete(listener);
    };
  }

  async emit<K extends keyof AgentEventMap & string>(
    event: K,
    payload: AgentEventMap[K],
  ): Promise<void> {
    await this.dispatch(event, payload, { emittedAt: Date.now() });
  }

  emitSync<K extends keyof AgentEventMap & string>(
    event: K,
    payload: AgentEventMap[K],
  ): void {
    this.dispatchSync(event, payload, { emittedAt: Date.now() });
  }

  removeAllListeners<K extends keyof AgentEventMap & string>(event?: K): void {
    if (event !== undefined) {
      this.listeners.delete(event);
      return;
    }
    this.listeners.clear();
    this.wildcards.clear();
  }

  listenerCount<K extends keyof AgentEventMap & string>(event: K): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  eventNames(): Array<keyof AgentEventMap & string> {
    return [...this.listeners.keys()] as Array<keyof AgentEventMap & string>;
  }

  /**
   * wire 重放入口——meta 取信封透传的 lineage,非本地 bus 身份。
   *
   * 同步分发(对齐 core EventBus 的 emitSync 语义):重放源不可等待,且
   * run_end 帧的分发必须先于投影拆除完成——逐个 await 会 yield 出同步段,
   * 让 teardown 的 removeAllListeners 插进分发中间(后续订阅者丢帧)。
   */
  dispatchWire(event: string, payload: unknown, meta: EventMeta): void {
    this.dispatchSync(event, payload, meta);
  }

  /** 进入时同时快照两个集合——分发期间的退订 / 清表不影响本帧可达性。 */
  private snapshot(event: string): {
    listeners: Array<Listener<never>>;
    wildcards: Array<WildcardListener<AgentEventMap>>;
  } {
    const set = this.listeners.get(event);
    return {
      listeners: set ? [...set] : [],
      wildcards: [...this.wildcards],
    };
  }

  private dispatchSync(event: string, payload: unknown, meta: EventMeta): void {
    const { listeners, wildcards } = this.snapshot(event);
    for (const listener of listeners) {
      try {
        const result = (listener as Listener<unknown>)(payload, meta);
        // 异步 listener 的错误仍需兜接,避免 unhandled rejection
        if (result instanceof Promise) {
          result.catch((err) => this.onListenerError(err, event));
        }
      } catch (err) {
        this.onListenerError(err, event);
      }
    }
    for (const wildcard of wildcards) {
      try {
        const result = (wildcard as WildcardListener<Record<string, unknown>>)(
          event,
          payload,
          meta,
        );
        if (result instanceof Promise) {
          result.catch((err) => this.onListenerError(err, event));
        }
      } catch (err) {
        this.onListenerError(err, event);
      }
    }
  }

  private async dispatch(
    event: string,
    payload: unknown,
    meta: EventMeta,
  ): Promise<void> {
    const { listeners, wildcards } = this.snapshot(event);
    for (const listener of listeners) {
      try {
        await (listener as Listener<unknown>)(payload, meta);
      } catch (err) {
        this.onListenerError(err, event);
      }
    }
    for (const wildcard of wildcards) {
      try {
        await (wildcard as WildcardListener<Record<string, unknown>>)(
          event,
          payload,
          meta,
        );
      } catch (err) {
        this.onListenerError(err, event);
      }
    }
  }
}
