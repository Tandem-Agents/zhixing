import type {
  EventBusOptions,
  EventMap,
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

  constructor(options: EventBusOptions = {}) {
    this.maxListeners = options.maxListeners ?? DEFAULT_MAX_LISTENERS;
    this.errorHandler =
      options.onError ??
      ((error, eventName) => {
        console.error(`[EventBus] Error in listener for "${eventName}":`, error);
      });
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
    const listeners = this.getListenersSnapshot(event);
    const wildcards = [...this.wildcardListeners];

    for (const listener of listeners) {
      try {
        await (listener as Listener<TMap[K]>)(payload);
      } catch (error) {
        this.errorHandler(error, event);
      }
    }

    for (const wildcard of wildcards) {
      try {
        await wildcard(event, payload);
      } catch (error) {
        this.errorHandler(error, event);
      }
    }
  }

  emitSync<K extends keyof TMap & string>(event: K, payload: TMap[K]): void {
    const listeners = this.getListenersSnapshot(event);
    const wildcards = [...this.wildcardListeners];

    for (const listener of listeners) {
      try {
        const result = (listener as Listener<TMap[K]>)(payload);
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
        const result = wildcard(event, payload);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((error) => this.errorHandler(error, event));
        }
      } catch (error) {
        this.errorHandler(error, event);
      }
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
 * 创建类型安全事件总线的工厂函数
 */
export function createEventBus<TMap extends EventMap>(
  options?: EventBusOptions,
): IEventBus<TMap> {
  return new EventBus<TMap>(options);
}
