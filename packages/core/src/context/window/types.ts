/**
 * 注意力窗口运行态的类型定义。
 *
 * 模块定位：窗口是"给 LLM 看什么"的唯一内存权威——持久化的派生视图，
 * 崩溃即弃、重启由启动装填重建。本模块只依赖 Message 与 system-meta
 * （摘要对构造），不依赖 transcript / loop / 任何调用方——窗口是上下文层
 * 概念，存储无关、平台无关，owner（会话层）可整体搬迁宿主。
 */

import type { Message } from "../../types/messages.js";

// ─── 窗口重构指令 ───

/**
 * 窗口重构指令 —— 段切换 / 手动压缩的产物，描述"哪些配对被摘要替代"。
 *
 * 它只表达 LLM 发送视图的变化，绝不被解释为持久化写入指令：原始 run record
 * 在磁盘上永不因压缩而删除，折叠只发生在内存窗口里。
 */
export interface WindowCompact {
  /** 折叠摘要平文本 —— 渲染为窗口首部的摘要对 */
  readonly summary: string;
  /**
   * 结构化三段摘要（段切换路径必填，机械兜底路径缺省）。
   * owner 据此写派生摘要快照（启动装填的摘要来源）；窗口本身只消费 summary。
   */
  readonly structuredSummary?: {
    readonly facts: string;
    readonly state: string;
    readonly active: string;
  };
  /** 段唯一标识（段切换路径产物，与 conversation segmentMetadata 关联） */
  readonly segmentId?: string;
  /**
   * 被本次摘要替代的窗口配对数 —— 折叠截断的唯一依据。
   * 超过现存配对数时按现存数 clamp（摘要可能覆盖了进行中 run 的内容，
   * 该 run 的配对尚未入窗，多出的计数自然落空）。
   */
  readonly pairsCompacted: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

// ─── 出入参 ───

export interface AcceptRunInput {
  /**
   * 本 run 的协议消息序列，首条为用户原文。
   *
   * 窗口内部派生蒸馏对 [首条, 末条 assistant]，调用方不拆字段——
   * 喂 [userMessage, assistantMessage] 或完整协议序列均可，派生逻辑不变。
   */
  readonly runMessages: readonly Message[];
  /**
   * 持久化分配的 run 序号 —— 折叠时作派生摘要快照的覆盖锚点。
   * 接受顺序是"先持久化成功、后入窗"，故调用时已可得；
   * 无持久化的场景（ephemeral）可缺省。
   */
  readonly runIndex?: number;
  /** 本 run 产出的窗口重构指令 —— 在追加本 run 配对之前应用 */
  readonly windowCompact?: WindowCompact;
}

export interface WindowFoldOutcome {
  /**
   * 被折叠的最后一个配对的 runIndex —— owner 据此给派生摘要快照定覆盖边界
   * （快照只声明"覆盖到哪个完整 run"，启动装填用它防摘要与原文重叠）。
   *
   * 未发生折叠、或被折配对缺 runIndex 时为 undefined。保守缺省只造成快照
   * 与原文轻微重叠，由启动装填"摘要严格早于原文"的取用规则吸收。
   */
  readonly coveredThroughRunIndex?: number;
}

export type WindowResetReason = "clear" | "switch";

export interface CreateAttentionWindowOptions {
  readonly conversationId?: string;
  /**
   * 启动装填对（system-meta user/assistant 对）—— 建窗时一次性置入，
   * 作为窗口起始条目。装填内容与 run 成败无关：run 失败回滚不动窗口，
   * 装填天然存续，直到被折叠摘要对取代。
   */
  readonly bootstrap?: readonly [Message, Message];
}

// ─── 窗口状态 ───

export interface AttentionWindowState {
  readonly conversationId?: string;

  /** 已接受的窗口事实（展平为消息序列；不含 in-flight 的当前用户消息） */
  getMessages(): readonly Message[];

  /**
   * 接受一个 run：先应用 windowCompact（若有），再追加本 run 的蒸馏对。
   *
   * 接受时机归 owner：先持久化成功、后调本方法——持久化失败则窗口不前进，
   * 下轮在同一基底上重试。
   */
  acceptRun(input: AcceptRunInput): WindowFoldOutcome;

  /**
   * run 外重构入口（手动压缩）：只应用折叠、不追加配对。
   * 与 acceptRun 共用同一折叠实现与元数据交出，owner 不触窗口内部结构。
   */
  applyCompact(windowCompact: WindowCompact): WindowFoldOutcome;

  /** 清空窗口（含 bootstrap 条目）——清空对话、切换对话时由 owner 调用 */
  reset(reason: WindowResetReason): void;
}
