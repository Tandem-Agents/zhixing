/**
 * 事件系统核心类型定义
 *
 * 设计原则：
 * - 泛型 EventMap 约束事件名与负载类型的映射关系，编译期保证类型安全
 * - 支持同步和异步监听器
 * - 通配符 '*' 监听所有事件
 */

/**
 * 事件映射表约束：键为事件名，值为该事件的负载类型
 */
export type EventMap = Record<string, unknown>;

/**
 * 事件监听器：可以是同步或异步函数
 */
export type Listener<T = unknown> = (payload: T) => void | Promise<void>;

/**
 * 通配符监听器：接收事件名 + 负载
 */
export type WildcardListener<TMap extends EventMap> = <K extends keyof TMap & string>(
  eventName: K,
  payload: TMap[K],
) => void | Promise<void>;

/**
 * 监听器取消订阅函数
 */
export type Unsubscribe = () => void;

/**
 * 事件总线配置
 */
export interface EventBusOptions {
  /**
   * 监听器抛出异常时的处理函数。
   * 默认行为：console.error 后继续执行其他监听器（错误隔离）。
   */
  onError?: (error: unknown, eventName: string) => void;

  /**
   * 最大监听器数量（每个事件），超出时触发警告。
   * 用于检测内存泄漏。默认 50。
   */
  maxListeners?: number;
}

/**
 * 类型安全事件总线接口
 */
export interface IEventBus<TMap extends EventMap> {
  /**
   * 注册事件监听器，返回取消订阅函数
   */
  on<K extends keyof TMap & string>(event: K, listener: Listener<TMap[K]>): Unsubscribe;

  /**
   * 注册一次性监听器，触发一次后自动移除
   */
  once<K extends keyof TMap & string>(event: K, listener: Listener<TMap[K]>): Unsubscribe;

  /**
   * 移除指定事件的指定监听器
   */
  off<K extends keyof TMap & string>(event: K, listener: Listener<TMap[K]>): void;

  /**
   * 注册通配符监听器，监听所有事件
   */
  onAny(listener: WildcardListener<TMap>): Unsubscribe;

  /**
   * 触发事件，按注册顺序执行所有监听器。
   * 异步监听器会被 await，错误会被隔离。
   */
  emit<K extends keyof TMap & string>(event: K, payload: TMap[K]): Promise<void>;

  /**
   * 同步触发事件（fire-and-forget），不等待异步监听器完成
   */
  emitSync<K extends keyof TMap & string>(event: K, payload: TMap[K]): void;

  /**
   * 移除指定事件的所有监听器。不传参则移除所有事件的所有监听器。
   */
  removeAllListeners<K extends keyof TMap & string>(event?: K): void;

  /**
   * 获取指定事件的监听器数量
   */
  listenerCount<K extends keyof TMap & string>(event: K): number;

  /**
   * 获取所有已注册事件名
   */
  eventNames(): Array<keyof TMap & string>;
}
