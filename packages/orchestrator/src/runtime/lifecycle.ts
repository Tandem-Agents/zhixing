/**
 * 主对话运行体生命周期钩子契约。
 *
 * 为经 createAgentRuntime 装配的 user-facing 主对话运行体（cli main / work、serve
 * 每会话 main）提供四阶段注册式介入点：
 *
 *   ① onWindowOpen   注意力窗口开启（首窗 + 段切换 / compact / clear / resume 后的新窗）
 *   ② onBeforeRun    每次 run 前（一条用户消息发送前）
 *   ③ onAfterRun     每次 run 后（多轮 LLM 全部干完）
 *   ④ onWindowClose  注意力窗口结束（旧窗终结，或实例销毁的末窗）
 *
 * 绑定单位分两层：外层（①④）绑**注意力窗口**，内层（②③）绑 **run**。订阅者集合
 * 在实例装配期注入、实例内恒定（注册单位是实例，触发单位是窗口 / run）。
 *
 * 它不替代 EventBus（观测仍走 EventBus）—— 补齐"生命周期边界、注册式、可在合适
 * 时机更新上下文"的介入：onWindowOpen 把"更新 system prompt 数据驱动段"作为
 * **公共接口**暴露，任何订阅者按需贡献；首个内置消费者是 skill 索引的窗口边界重建。
 *
 * 唯一排除 Task 工具派生的 sub-agent —— 它不经 createAgentRuntime、不启用段切换、
 * 无注意力窗口换代，by-construction 不携带本钩子。
 */

import type { Message, RunResult } from "@zhixing/core";
import type { SystemPromptSegment } from "./system-prompt.js";

/**
 * 运行时可在窗口边界更新的"数据驱动段" —— 内容由运行体内可变数据源驱动、需随
 * 窗口边界刷新。第一版只有 skill-index；新增数据驱动段时在此扩枚举。
 *
 * 用 Extract 锁定为 SystemPromptSegment 子集：若 system-prompt 删除了该段名会
 * 立即编译失败。profile 驱动段（identity / principles / style / safety 等）变化
 * 单位是 reload、不属此类，故不在此枚举、也无法经 updateSystemPromptSegment 覆盖。
 */
export type DataDrivenSegment = Extract<SystemPromptSegment, "skill-index">;

/** 注意力窗口开启原因。 */
export type WindowOpenReason =
  | "instance-start" // 首窗：实例装配
  | "segment-transition" // 段切换产生新窗（run 内）
  | "compact" // 手动 /compact 强制切段产生新窗（run 外）
  | "clear" // /clear 清空后新窗（run 外）
  | "resume"; // /resume 换对话后新窗（run 外）

/** 注意力窗口结束原因 —— 窗口换代（实例存活）或实例销毁（末窗收尾）。 */
export type WindowCloseReason =
  // —— 窗口换代（实例存活，旧窗终结、紧接新窗）——
  | "segment-transition"
  | "compact"
  | "clear"
  | "resume"
  // —— 实例销毁（末窗收尾，实例退场）——
  | "session-dispose" // 会话实例整体销毁（cli 断开 / serve 会话驱逐）
  | "workmode-exit" // exitWorkMode 丢弃 work 运行体
  | "reload-replace" // reload 换代、退役旧实例
  | "assembly-rollback"; // 装配事务回滚、实例从未上位

/**
 * 实例销毁原因 —— AgentRuntime.dispose(reason) 的入参,透传末窗 onWindowClose。
 * 是 WindowCloseReason 的销毁子集（换代类 reason 走 onAttentionWindowChange）。
 */
export type DisposeReason = Extract<
  WindowCloseReason,
  "session-dispose" | "workmode-exit" | "reload-replace" | "assembly-rollback"
>;

/**
 * run 外注意力窗口换代原因 —— onAttentionWindowChange(reason) 的入参（/clear ·
 * /resume · 手动 /compact）。run 内换代（段切换）走 agent-loop 的
 * windowLifecycle.onChange。
 */
export type AttentionWindowChangeReason = Extract<
  WindowOpenReason,
  "clear" | "resume" | "compact"
>;

/** 所有 ctx 共享的运行体身份字段。 */
export interface LifecycleContextBase {
  /** 运行体实例唯一 id（装配期生成，仅用于事件归属 / 日志，不持久化） */
  readonly runtimeId: string;
  readonly mode: "main" | "work";
  /** work 运行体的工作场景 id（main 运行体为 undefined） */
  readonly sceneId?: string;
  readonly providerId: string;
  readonly model: string;
}

export interface LifecycleWindowOpenContext extends LifecycleContextBase {
  readonly reason: WindowOpenReason;
  /** 本实例内第几个窗口（首窗 0） */
  readonly windowIndex: number;
  /**
   * 公共接口：在本注意力窗口边界更新 system prompt 的一个数据驱动段。任何订阅者
   * 按需调用、贡献自己负责的段内容（传 null 清空该段）；不调则该段不变。运行体把
   * 贡献记入本窗的段覆盖视图，本窗 onWindowOpen 全部跑完后据此重新拼装、自管
   * byte-equal。
   *
   * 形态约束（非私有化）：只收"段内容"、不收"整串" —— 外部订阅者没有 buildSystemPrompt
   * 的全部段输入、算不出正确整串，拼装归运行体（与 TurnContextInjector「贡献段、
   * 拼装归 runtime」同构）。段参数用 DataDrivenSegment 把语义边界钉在类型层。
   */
  updateSystemPromptSegment(segment: DataDrivenSegment, content: string | null): void;
}

export interface LifecycleBeforeRunContext extends LifecycleContextBase {
  readonly conversationId?: string;
  readonly turnIndex: number;
  /** 该 run 是否其所在注意力窗口的首个 run（窗口可在 run 内换代，按 run 入口时
   *  所在窗口判定）—— 供订阅者区分「每窗口首 run 才做」与「每 run 都做」。 */
  readonly isWindowFirstRun: boolean;
  /** 本次 run 输入（只读：观测 + 读取用户这条说了什么） */
  readonly messages: readonly Message[];
  /**
   * 贡献式注入出口：递交要注入「当前 run 用户消息」的内容。运行体收齐所有订阅者的
   * 贡献后拼成一个 <context> 块、前缀到当前 run 的用户消息；传 null / 不调 = 不注。
   * 注到哪条、怎么包、什么顺序归运行体（与 onWindowOpen 的 updateSystemPromptSegment
   * 同范式）—— 订阅者不改 messages、不自己找位置或去重。
   */
  injectUserContext(content: string | null): void;
}

export interface LifecycleAfterRunContext extends LifecycleContextBase {
  readonly conversationId?: string;
  readonly turnIndex: number;
  readonly result: Readonly<RunResult>;
}

export interface LifecycleWindowCloseContext extends LifecycleContextBase {
  readonly reason: WindowCloseReason;
  readonly windowIndex: number;
}

/**
 * 主对话运行体生命周期钩子。订阅者集合在装配期注入一个运行体实例、实例内恒定；
 * 框架在该实例的注意力窗口边界（①④）与 run 边界（②③）按注册顺序串行调用。
 * 所有钩子可选、可 async。
 */
export interface AgentRuntimeLifecycle {
  /** 订阅者标识 —— 日志、错误归属、可观测事件。全局唯一。 */
  readonly id: string;

  /** ① 注意力窗口开启：首窗（实例装配）或窗口换代后（段切换 / compact / clear /
   *  resume）新窗诞生时调。ctx 暴露公共的"更新 system prompt 数据驱动段"接口，
   *  任何订阅者按需用 —— 这是 cache 安全的窗口级上下文更新点。 */
  onWindowOpen?(ctx: LifecycleWindowOpenContext): Promise<void> | void;

  /** ② 每次 run 前：run() 入口、agent-loop 启动前调 —— run 前唯一业务介入点。
   *  观测即将发送的 messages、异步副作用，以及经 ctx.injectUserContext 向当前 run
   *  用户消息贡献注入内容。不重建 system prompt（run 边界在窗口内）。 */
  onBeforeRun?(ctx: LifecycleBeforeRunContext): Promise<void> | void;

  /** ③ 每次 run 后：run() 产出 RunResult 后调。观测 + 状态更新（本轮已结束）。 */
  onAfterRun?(ctx: LifecycleAfterRunContext): Promise<void> | void;

  /** ④ 注意力窗口结束：旧窗终结（段切换 / compact / clear / resume 前）或实例
   *  销毁（末窗）时调。收尾 / flush。 */
  onWindowClose?(ctx: LifecycleWindowCloseContext): Promise<void> | void;
}
