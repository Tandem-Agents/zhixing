import type {
  EventBusOptions,
  EventMap,
  EventMeta,
  IEventBus,
  Listener,
  Unsubscribe,
  WildcardListener,
} from "./types.js";

const DEFAULT_MAX_LISTENERS = 50;

/**
 * 类型安全事件总线
 *
 * 核心设计：
 * - 泛型 TMap 在编译期保证事件名与负载类型严格匹配
 * - 错误隔离：单个监听器的异常不影响其他监听器执行
 * - 支持 on/once/onAny 三种订阅模式
 * - emit 异步等待所有监听器，emitSync 立即返回
 * - 层级化:子 bus emit 后本地 listeners 先跑,事件再向父 bus 冒泡(深度优先到根)。
 *   meta(lineage / emittedAt)走侧通道,父接收时透传同一份 meta —— 始终标识
 *   "最初 emit 的子 bus",无论冒泡多少层
 *
 * 对比 OpenClaw/Claude Code：它们没有独立的事件系统，
 * 可观测性靠硬编码日志。我们的事件总线是一等公民，
 * 所有模块通过事件通信，天然可观测。
 */
export class EventBus<TMap extends EventMap> implements IEventBus<TMap> {
  private readonly listeners = new Map<string, Array<Listener<never>>>();
  private readonly wildcardListeners: Array<WildcardListener<TMap>> = [];
  private readonly onceWrappersToOriginal = new WeakMap<Listener<never>, Listener<never>>();
  private readonly maxListeners: number;
  private readonly errorHandler: (error: unknown, eventName: string) => void;
  private readonly parent?: EventBus<TMap>;
  readonly lineage: string | undefined;

  constructor(options: EventBusOptions<TMap> = {}) {
    this.maxListeners = options.maxListeners ?? DEFAULT_MAX_LISTENERS;
    this.errorHandler =
      options.onError ??
      ((error, eventName) => {
        console.error(`[EventBus] Error in listener for "${eventName}":`, error);
      });

    // parent 类型在 EventBusOptions 中已收紧为 EventBus<TMap>(不接受任意
    // IEventBus 实现),因此此处直接赋值无需 cast —— 由 TypeScript 在
    // 编译期阻止"传 mock IEventBus 导致 emit 时找不到内部 dispatch"的问题。
    this.parent = options.parent;
    this.lineage = options.lineage;

    // 不变量:子 lineage 必须以 parent.lineage + "/" 开头(若父子都设了 lineage)
    if (
      this.parent?.lineage !== undefined &&
      this.lineage !== undefined &&
      !this.lineage.startsWith(`${this.parent.lineage}/`)
    ) {
      throw new Error(
        `EventBus lineage "${this.lineage}" must start with parent lineage + "/" ` +
          `("${this.parent.lineage}/")`,
      );
    }
  }

  on<K extends keyof TMap & string>(event: K, listener: Listener<TMap[K]>): Unsubscribe {
    const listeners = this.getOrCreateListeners(event);
    listeners.push(listener as Listener<never>);
    this.checkMaxListeners(event, listeners.length);

    return () => this.off(event, listener);
  }

  once<K extends keyof TMap & string>(event: K, listener: Listener<TMap[K]>): Unsubscribe {
    const wrapper: Listener<TMap[K]> = (payload) => {
      this.off(event, wrapper);
      return listener(payload);
    };
    // 保留原始引用映射，支持通过原始 listener 调用 off 移除
    this.onceWrappersToOriginal.set(wrapper as Listener<never>, listener as Listener<never>);

    return this.on(event, wrapper);
  }

  off<K extends keyof TMap & string>(event: K, listener: Listener<TMap[K]>): void {
    const listeners = this.listeners.get(event);
    if (!listeners) return;

    const typedListener = listener as Listener<never>;
    const index = listeners.indexOf(typedListener);
    if (index !== -1) {
      listeners.splice(index, 1);
    } else {
      // 尝试匹配 once 包装器（用户可能用原始 listener 调用 off）
      const wrapperIndex = listeners.findIndex(
        (l) => this.onceWrappersToOriginal.get(l) === typedListener,
      );
      if (wrapperIndex !== -1) {
        listeners.splice(wrapperIndex, 1);
      }
    }

    if (listeners.length === 0) {
      this.listeners.delete(event);
    }
  }

  onAny(listener: WildcardListener<TMap>): Unsubscribe {
    this.wildcardListeners.push(listener);

    return () => {
      const index = this.wildcardListeners.indexOf(listener);
      if (index !== -1) {
        this.wildcardListeners.splice(index, 1);
      }
    };
  }

  async emit<K extends keyof TMap & string>(event: K, payload: TMap[K]): Promise<void> {
    await this.dispatch(event, payload, this.makeMeta());
  }

  emitSync<K extends keyof TMap & string>(event: K, payload: TMap[K]): void {
    this.dispatchSync(event, payload, this.makeMeta());
  }

  /**
   * 仅当 bus 设了 lineage 才构造 meta —— 无 lineage 的根 bus 保持"emit 时不附 meta"
   * 的旧契约,listener 调用时只传 payload,严格保持二进制 API 兼容。
   */
  private makeMeta(): EventMeta | undefined {
    return this.lineage !== undefined
      ? { lineage: this.lineage, emittedAt: Date.now() }
      : undefined;
  }

  /**
   * 内部派发:本地 listeners → wildcards → 父冒泡。
   *
   * meta 由顶层 emit 一次构造,递归向上透传时不重建 —— 保证 meta.lineage
   * 始终是"最初 emit 的子 bus"的 lineage,无论冒泡多少层。meta 为 undefined 时
   * listener 调用形如 `listener(payload)`,与历史行为字节级一致。
   */
  private async dispatch<K extends keyof TMap & string>(
    event: K,
    payload: TMap[K],
    meta: EventMeta | undefined,
  ): Promise<void> {
    const listeners = this.getListenersSnapshot(event);
    const wildcards = [...this.wildcardListeners];

    for (const listener of listeners) {
      try {
        const typed = listener as Listener<TMap[K]>;
        await (meta !== undefined ? typed(payload, meta) : typed(payload));
      } catch (error) {
        this.errorHandler(error, event);
      }
    }

    for (const wildcard of wildcards) {
      try {
        await (meta !== undefined ? wildcard(event, payload, meta) : wildcard(event, payload));
      } catch (error) {
        this.errorHandler(error, event);
      }
    }

    if (this.parent) {
      await this.parent.dispatch(event, payload, meta);
    }
  }

  private dispatchSync<K extends keyof TMap & string>(
    event: K,
    payload: TMap[K],
    meta: EventMeta | undefined,
  ): void {
    const listeners = this.getListenersSnapshot(event);
    const wildcards = [...this.wildcardListeners];

    for (const listener of listeners) {
      try {
        const typed = listener as Listener<TMap[K]>;
        const result = meta !== undefined ? typed(payload, meta) : typed(payload);
        // 异步返回值的错误仍需捕获，避免 unhandled rejection
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((error) => this.errorHandler(error, event));
        }
      } catch (error) {
        this.errorHandler(error, event);
      }
    }

    for (const wildcard of wildcards) {
      try {
        const result =
          meta !== undefined ? wildcard(event, payload, meta) : wildcard(event, payload);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((error) => this.errorHandler(error, event));
        }
      } catch (error) {
        this.errorHandler(error, event);
      }
    }

    if (this.parent) {
      this.parent.dispatchSync(event, payload, meta);
    }
  }

  removeAllListeners<K extends keyof TMap & string>(event?: K): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
      this.wildcardListeners.length = 0;
    }
  }

  listenerCount<K extends keyof TMap & string>(event: K): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  eventNames(): Array<keyof TMap & string> {
    return [...this.listeners.keys()];
  }

  /**
   * 获取监听器快照，避免在 emit 过程中因 once 移除而跳过监听器
   */
  private getListenersSnapshot(event: string): Array<Listener<never>> {
    const listeners = this.listeners.get(event);
    return listeners ? [...listeners] : [];
  }

  private getOrCreateListeners(event: string): Array<Listener<never>> {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = [];
      this.listeners.set(event, listeners);
    }
    return listeners;
  }

  private checkMaxListeners(event: string, count: number): void {
    if (count > this.maxListeners) {
      console.warn(
        `[EventBus] Event "${event}" has ${count} listeners ` +
          `(max: ${this.maxListeners}). Possible memory leak.`,
      );
    }
  }
}

/**
 * 创建类型安全事件总线的工厂函数。
 *
 * 返回 `EventBus<TMap>`(类)而非 `IEventBus<TMap>`(接口) —— 让消费者直接把
 * 返回值传入子 bus 的 `parent` 字段时类型自然匹配,无需手动 cast。需要消费者
 * 契约视角时仍可显式标注 `: IEventBus<TMap>`,EventBus 结构性满足该接口。
 */
export function createEventBus<TMap extends EventMap>(
  options?: EventBusOptions<TMap>,
): EventBus<TMap> {
  return new EventBus<TMap>(options);
}
