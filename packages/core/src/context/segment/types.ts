/**
 * 段切换模块的类型与接口定义。
 *
 * 模块职责：在对话累积达到 attention 阈值时，把当前段历史压缩为结构化摘要 +
 * 缓冲带，作为新段首条 user message 启动新段。与 ContextEngine 的 budget 兜底
 * 是并列关系（budget-driven vs attention-driven），不是嵌套。
 *
 * 关键抽象（让 SegmentManager 编排层保持单一职责）：
 *   - SegmentThresholds：attention 阈值的结构化兼容子集（避免 core 反向 import providers）
 *   - SegmentDecision：纯函数决策结果（pass / defer / trigger）
 *   - SegmentSummarizeLLMFn：压缩 LLM 调用签名（必须携带完整 system + tools，保 cache prefix byte-equal）
 *   - SegmentPersistence：段切换写入路径抽象（与 ConversationRepository / TranscriptStore 解耦）
 *   - TaskListReader：task_list 状态读取抽象（避免 core 反向 import tools-builtin）
 *   - SegmentTransitionHook：扩展点接口（仅预留，第一版无内置实现）
 */

import type { SegmentMeta } from "../../conversation/types.js";
import type { CompactMarker } from "../../transcript/types.js";
import type { Message } from "../../types/messages.js";
import type { ToolSpec } from "../../types/tools.js";

// ─── 决策 ───

/**
 * SegmentManager 关心的 attention 阈值子集。
 *
 * 用专用结构兼容接口而不是直接依赖 ModelCapability，是因为 ModelCapability
 * 完整类型与数据归属 @zhixing/providers 包（与 vendor presets 同质），而 core
 * 包不应反向 import providers。调用方传入完整 ModelCapability 时 TypeScript
 * 结构兼容性自动接受。
 */
export interface SegmentThresholds {
  readonly optimalMaxTokens: number;
  readonly riskMaxTokens: number;
}

/**
 * 决策结果 —— `decideSegmentAction` 的返回值。
 *
 * 三种状态：
 *   - pass：低于 optimal 阈值，或无 conversationId（ephemeral 路径） —— 无须干预
 *   - defer：处于 optimal 与 risk 之间且 task_list 有 in-progress 项 —— 推迟到 risk 触发，避开自然停顿外的切段
 *   - trigger：超过 optimal（无 in-progress）或超过 risk（强制） —— 立即切段
 */
export type SegmentDecision =
  | {
      readonly kind: "pass";
      readonly reason: "below-optimal" | "no-conversation";
    }
  | {
      readonly kind: "defer";
      readonly reason: "in-progress-task";
      readonly currentTokens: number;
      readonly threshold: number;
    }
  | {
      readonly kind: "trigger";
      readonly reason: "optimal-exceeded" | "risk-exceeded";
      readonly currentTokens: number;
      readonly threshold: number;
    };

// ─── 结构化摘要 ───

/**
 * 段切换 LLM 输出的三段结构化摘要。
 *
 * 内容契约（写入 prompt 引导 LLM 输出）：
 *   - facts：已发生的事实、事件、决策（结论性陈述，不展开过程）
 *   - state：当前进行中的任务、未完成事项、用户期望（让协作者知道继续做什么）
 *   - active：后续协作必须的具体信息（文件路径、变量名、技术决策、用户偏好）
 *
 * 解析容错：单段缺失时降级为空字符串而非抛错——LLM 偶发输出不规范时仍能继续，
 * compose 层把空段渲染为空标签，新段对话流量不至于中断。
 */
export interface ParsedSummary {
  readonly facts: string;
  readonly state: string;
  readonly active: string;
}

// ─── 压缩 LLM 调用 ───

/**
 * 压缩 LLM 调用请求 —— 必须携带完整 system + tools + messages，
 * 仅在 messages 末尾追加压缩指令，让请求形态与上一轮 byte-equal，cache 完美命中。
 *
 * 设计警示（违反任一都会让 cache 全部失效，破坏段切换"几乎免费"的物理依据）：
 *   - 不可省略 tools[] —— tools 是 LLM 请求 prefix 的一部分（OpenAI/Anthropic
 *     wire format 都会序列化进入 cache key），省略后 cache key 错位
 *   - 不可换 model / provider / 账号 —— 跨实例 cache 不共享
 *   - messages 末尾的压缩指令是唯一新 token，其前所有内容必须与上一轮完全相同
 */
export interface SegmentSummarizeRequest {
  readonly systemPrompt: string;
  readonly tools: readonly ToolSpec[];
  readonly messages: readonly Message[];
  readonly abortSignal?: AbortSignal;
}

/**
 * 压缩 LLM 调用函数签名。
 *
 * 实现由 wiring 层从主对话 provider 构造，保证与主对话同 provider/账号/model
 * ——切实例会破坏 cache 命中前提。
 *
 * 失败语义：实现可抛错（network / provider error / abort）；SegmentManager
 * 内含 retry，最终失败 emit 事件并降级为不切，绝不阻塞 turn。
 */
export type SegmentSummarizeLLMFn = (
  request: SegmentSummarizeRequest,
) => Promise<string>;

// ─── 持久化抽象 ───

/**
 * 段切换持久化接口 —— 只负责 segmentMetadata 累积写入。
 *
 * **不**承担 transcript marker 写入：marker 通过 `segment:new_started` 事件
 * 流向 orchestrator accumulator，与本 turn 的 transcript 写入在 run 结束时
 * 同一原子事务（commitTurn）落盘，与 LLMSummarize 路径同模式，整个 run 内
 * transcript 写入收敛到唯一路径——杜绝"两条独立写路径并存"类不一致。
 *
 * 实现需保证 atomic + per-id lock（与 conversation.writeMeta 同款）。
 * conversation 不存在时 no-op（与 task_list state 写入同语义）。
 *
 * appendSegment 失败语义：marker 落盘走另一条数据流（事件 → accumulator →
 * commitTurn），与 segmentMetadata 写入解耦；本接口失败不影响段切换主流程
 * 完成度，只影响段历史观测元数据完整性。SegmentManager 内部捕获后 emit
 * `segment:transition_failed` 但 `modified: true` 返回（段切换语义上成功）。
 */
export interface SegmentPersistence {
  appendSegment(conversationId: string, meta: SegmentMeta): Promise<void>;
}

// ─── task_list 读取抽象 ───

/**
 * task_list 状态读取接口 —— 段切换决策时判断"是否有 in-progress 任务"。
 *
 * 抽象目的：core 不能反向 import @zhixing/tools-builtin（依赖倒置）；
 * 通过 reader 接口由 cli 装配层注入实现。
 *
 * 实现契约：
 *   - 同步返回（决策路径不应触 IO，task_list 在 service cache 中读）
 *   - conversation 不存在 / 无 task_list state 时返 false（与 ephemeral 路径自然降级一致）
 */
export interface TaskListReader {
  hasInProgress(conversationId: string): boolean;
}

// ─── 扩展点 ───

/**
 * 段切换扩展点 —— 在段切换的三个关键时刻接入业务逻辑。
 *
 * 第一版仅预留接口，不内置任何 hook 实现。候选未来用途：
 *   - beforeSummarize：自动 memory.save 引导 / 任务边界推断
 *   - afterSummarize：摘要质量评估 / 用户通知
 *   - beforeNewSegmentStart：段统计上报 / 内嵌业务标记
 *
 * 执行顺序：注册顺序 sequential await，任一 hook 抛错不阻断段切换主流程
 * （SegmentManager 内 try-catch 后继续，hook 失败被独立 emit 事件）。
 */
export interface SegmentTransitionHook {
  beforeSummarize?(ctx: SegmentTransitionContext): Promise<void>;
  afterSummarize?(
    ctx: SegmentTransitionContext,
    summary: ParsedSummary,
  ): Promise<void>;
  beforeNewSegmentStart?(ctx: SegmentTransitionContext): Promise<void>;
}

export interface SegmentTransitionContext {
  readonly conversationId: string;
  readonly segmentId: string;
  readonly tokensBefore: number;
}

// ─── SegmentManager 输入 / 输出 ───

/**
 * SegmentManager.evaluate 输入。
 *
 * conversationId 缺失（ephemeral 路径：定时任务 / --print）→ 决策直接 pass，
 * 不走压缩流程也不走持久化。与 task_list 工具 / TaskListProvider 同语义对齐。
 */
export interface SegmentManagerInput {
  readonly messages: readonly Message[];
  readonly systemPrompt: string;
  readonly tools: readonly ToolSpec[];
  readonly turnCount: number;
  readonly conversationId: string | undefined;
  readonly abortSignal?: AbortSignal;
}

/**
 * SegmentManager.evaluate 输出。
 *
 * modified=true 时调用方应替换 state.messages 为 newSegmentMessages；
 * decision 始终填充（即使 modified=false 时仍可用于诊断与可观测性）。
 */
export interface SegmentManagerOutput {
  readonly decision: SegmentDecision;
  readonly modified: boolean;
  readonly newSegmentMessages?: Message[];
  readonly marker?: CompactMarker;
}
