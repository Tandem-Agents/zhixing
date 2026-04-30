/**
 * 事件系统核心类型定义
 *
 * 设计原则：
 * - 泛型 EventMap 约束事件名与负载类型的映射关系，编译期保证类型安全
 * - 支持同步和异步监听器
 * - 通配符 '*' 监听所有事件
 * - 层级化:bus 可指定 parent + lineage,emit 自动冒泡;meta 走侧通道,
 *   不污染 payload 类型
 *
 * 接口与实现的语义分层:
 *   - `IEventBus` 描述消费者契约(on / off / emit / lineage)
 *   - `EventBus` 类是唯一具体实现,内部持冒泡协议(私有 dispatch 方法)
 *   - 父子关系是 EventBus 实现细节,因此 EventBusOptions.parent 强类型为
 *     `EventBus<TMap>`(类),不接受任意 IEventBus 实现 —— 在编译期阻止
 *     "传入 mock IEventBus 当 parent 导致运行时崩"的问题
 */

import type { EventBus } from "./event-bus.js";

/**
 * 事件映射表约束：键为事件名，值为该事件的负载类型
 */
export type EventMap = Record<string, unknown>;

/**
 * 事件 meta 侧通道 —— 描述事件的源 bus 信息,与 payload 解耦,不参与类型映射。
 *
 * 旧式 listener `(payload) => ...` 完全无感(JS 调用允许多余实参);新式
 * listener `(payload, meta) => ...` 按需读 meta,例如根据 lineage 区分
 * 主 / 子 agent 事件。
 */
export interface EventMeta {
  /** emit 来源 bus 的 lineage 路径,e.g. "main"、"main/sub-a3f"。bus 未设则 undefined */
  lineage?: string;
  /** emit 时刻 epoch ms */
  emittedAt?: number;
}

/**
 * 事件监听器：可以是同步或异步函数
 *
 * meta 是可选第二参 —— 旧式单参 listener 完全兼容,新式按需读取冒泡来源信息。
 */
export type Listener<T = unknown> = (
  payload: T,
  meta?: EventMeta,
) => void | Promise<void>;

/**
 * 通配符监听器：接收事件名 + 负载 + 可选 meta
 */
export type WildcardListener<TMap extends EventMap> = <K extends keyof TMap & string>(
  eventName: K,
  payload: TMap[K],
  meta?: EventMeta,
) => void | Promise<void>;

/**
 * 监听器取消订阅函数
 */
export type Unsubscribe = () => void;

/**
 * 事件总线配置
 */
export interface EventBusOptions<TMap extends EventMap = EventMap> {
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

  /**
   * 父 bus —— 子 bus emit 时本地 listeners 跑完后,事件向父冒泡(递归向上),
   * 同一份 meta 透传到根。父子 EventMap 类型必须一致(子 agent 与主 agent
   * 当前都用 AgentEventMap)。
   *
   * 类型刻意收紧到 `EventBus<TMap>`(类)而非 `IEventBus<TMap>`(接口):
   * 父子冒泡走 EventBus 的私有 dispatch 协议,接口层不暴露此方法。任意第三方
   * IEventBus 实现作为 parent 会让 emit 时找不到 dispatch 而崩,类型层面
   * 收紧把这类问题前移到编译期。
   */
  parent?: EventBus<TMap>;

  /**
   * 当前 bus 的 lineage 路径 —— 主 bus 通常 "main",子 bus 通常
   * "main/sub-<8 字符 id>" 之类的延伸。emit 时附在 meta.lineage,无论
   * 冒泡多少层都标识"最初 emit 的 bus"。
   *
   * 不变量:若 parent 也设了 lineage,本 bus 的 lineage 必须以
   * `parent.lineage + "/"` 开头(构造时 throw)。
   */
  lineage?: string;
}

/**
 * 类型安全事件总线接口
 */
export interface IEventBus<TMap extends EventMap> {
  /** 当前 bus 的 lineage,见 {@link EventBusOptions.lineage}。未设则 undefined */
  readonly lineage: string | undefined;

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
