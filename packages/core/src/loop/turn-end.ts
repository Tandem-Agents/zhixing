/**
 * Turn 结束钩子 —— agent-loop 在每个 turn 结束时调用一次的内部协调器。
 *
 * ─── 是什么 ───
 *
 * "Turn 结束"是 agent-loop 的一阶语义概念 —— 一次完整的 LLM round-trip 完成后、
 * 即将退出 run 或继续下一次 LLM call 的临界点。本钩子封装 turn 结束的全部副作用
 * 编排，让 agent-loop 主循环只关心"什么时候是 turn 结束"，"turn 结束做什么"完全
 * 收敛到这里。
 *
 * 钩子内部不感知调用方上下文：所有副作用按"turn 结束"语义统一处理，差异由
 * caller 自行决定如何消费 outcome。
 *
 * ─── 为什么需要 ───
 *
 * 历史上 turn 结束副作用（contextManager budget 兜底、segmentManager attention
 * 切段）散落在 agent-loop 主循环里手写多遍，加新 turn 结束副作用必须同步改所有
 * 触发点。本钩子把这个语义提升为单点 —— turn 结束做什么，看这一个函数即可。
 *
 * ─── 钩子职责 ───
 *
 *   ① budget-driven 兜底（ContextManager / 窗口百分比触发）
 *   ② attention-driven 切段（SegmentManager / 注意力阈值触发）
 *   ③ 未来扩展：metrics / persistence checkpoint / per-turn 任意副作用
 *
 * 副作用按声明顺序串行执行，前者修改的 messages 自动流入后者；任一副作用返回
 * terminal（如 contextManager error/aborted）立即短路返回，不再继续。
 *
 * ─── 扩展点 ───
 *
 * 加新 turn 结束副作用的标准流程：
 *
 *   a. 在 `TurnEndParams` 接口增加可选字段（新副作用需要的依赖）
 *   b. 在本函数体内按位置追加副作用代码，消费 / 改写 `messages` 变量
 *   c. agent-loop caller 透传新字段（agent-loop.ts 两处 runTurnEnd 调用）
 *
 * a + c 是接口契约扩展（强制类型同步），b 是真正的副作用编排单点。
 *
 * 不引入"hook 注册机制 / 插件接口"等额外抽象：当前两个副作用 + 未来扩展的预期
 * 数量都不足以支撑一阶插件协议（YAGNI）。直接函数体内追加的代码组织已足够清晰，
 * 且让副作用顺序在代码上显式可见（避免注册顺序隐式依赖）。
 *
 * ─── 不承担的职责 ───
 *
 *   - 事件 yield（如 turn_complete）：generator 协议层，agent-loop 主循环按自己
 *     的时机 yield。钩子是 async function 而非 generator，保持职责清晰。
 *   - 状态推进（state = {...}）：state 是 agent-loop 主循环私有状态机，钩子
 *     只返回处理后的 messages，由 caller 决定如何消费（写回 state 或丢弃）。
 *   - finalizeRun 调用：终止流程单点退出在 agent-loop，钩子只返回 terminal
 *     AgentResult，由 caller 调 finalizeRun。
 */

import {
  resolveContextManager,
  type ContextTermination,
} from "../context/termination.js";
import type { ContextManagerHook } from "../context/types.js";
import type { SegmentManager } from "../context/segment/segment-manager.js";
import type { TokenUsage } from "../types/llm.js";
import type { Message } from "../types/messages.js";
import { toToolSpec } from "../types/tools.js";
import type { ToolDefinition } from "../types/tools.js";
import type { AgentResult } from "./types.js";

// ─── 输出 ───

/**
 * 钩子返回值 —— 判别联合。
 *
 *   - kind="ok"       → 副作用全部完成，messages 是最终版本（可能被改写）
 *   - kind="terminal" → 某个副作用要求终止 run，caller 据此调 finalizeRun
 */
export type TurnEndOutcome =
  | { readonly kind: "ok"; readonly messages: Message[] }
  | { readonly kind: "terminal"; readonly result: AgentResult };

// ─── 输入 ───

export interface TurnEndParams {
  // ── per-call 数据 ──

  /** 本 turn 结束时的完整 messages（caller 按各自路径构造） */
  readonly messages: Message[];
  /** 本 turn 序号（已 +1，反映"已完成"语义） */
  readonly turnCount: number;
  /** 本 run 累积 usage —— 用于构造 terminal AgentResult */
  readonly usage: TokenUsage;
  /** abort 信号 —— 透传给所有副作用模块 */
  readonly abortSignal: AbortSignal;

  // ── 配置依赖 ──

  /** budget-driven 兜底（可选；缺省时 budget 步骤静默 no-op） */
  readonly contextManager?: ContextManagerHook;
  /** attention-driven 段切换（可选；缺省时段切换步骤静默 no-op） */
  readonly segmentManager?: SegmentManager;
  /** 段切换 LLM 调用必要：保 cache prefix byte-equal */
  readonly systemPrompt: string;
  /** 段切换 LLM 调用必要：保 cache prefix byte-equal */
  readonly tools: readonly ToolDefinition[];
  /** 段切换 ephemeral 路径判定（缺省 → SegmentManager 内部静默 pass） */
  readonly conversationId?: string;
}

// ─── 钩子 ───

/**
 * 执行 turn 结束副作用编排。
 *
 * 串行顺序：
 *   ① budget-driven 兜底（contextManager）
 *   ② attention-driven 切段（segmentManager）
 *   ③ 未来扩展点 —— 在此追加新副作用，保持 messages 链式传递
 *
 * 失败语义：
 *   - contextManager terminal（error / aborted）→ 钩子立即短路返回 terminal，
 *     不再调段切换。与原 agent-loop 在 toTerminalAgentResult 后立即 finalizeRun
 *     的行为一致 —— context 失败时不应再花 LLM 成本做段切换。
 *   - segmentManager 失败 → SegmentManager 内部已捕获并 emit transition_failed，
 *     返回 modified=false，钩子拿原 messages 继续。
 */
export async function runTurnEnd(
  params: TurnEndParams,
): Promise<TurnEndOutcome> {
  let messages = params.messages;

  // ① budget-driven 兜底
  const ctx = await resolveContextManager(
    params.contextManager,
    {
      messages,
      turnCount: params.turnCount,
      abortSignal: params.abortSignal,
    },
    params.abortSignal,
    "turn-end",
  );
  const terminal = toTerminalAgentResult(ctx, params.usage);
  if (terminal) return { kind: "terminal", result: terminal };
  if (ctx.kind === "ok" && ctx.output.modified) {
    messages = ctx.output.messages;
  }

  // ② attention-driven 段切换
  //
  // 与 contextManager 并列，是 attention-driven 主路径；contextManager 是
  // budget-driven 兜底。段切换看的是 contextManager 处理后的 messages —— 隐式
  // 不变量是 budget compact 阈值 × contextWindow > attention optimalMaxTokens，
  // 保证 attention 阈值远早于 budget compact 触发；用户颠倒阈值会让段切换
  // 处理已被 budget summarize 的 messages（功能不破，仅降级摘要质量）。
  //
  // 段切换失败绝不阻塞 turn —— evaluate 返 modified:false 时拿原 messages 继续。
  //
  // marker 写盘走 segment:new_started 事件 → orchestrator accumulator →
  // run-agent 单点 commitTurn 落盘，与 budget summarize 路径同模式。
  if (params.segmentManager) {
    const seg = await params.segmentManager.evaluate({
      messages,
      systemPrompt: params.systemPrompt,
      tools: params.tools.map(toToolSpec),
      turnCount: params.turnCount,
      conversationId: params.conversationId,
      abortSignal: params.abortSignal,
    });
    if (seg.modified && seg.newSegmentMessages) {
      messages = seg.newSegmentMessages;
    }
  }

  // ③ 未来扩展点 —— 新副作用直接在此追加：
  //    - 复用上方 messages 变量（链式传递）
  //    - 失败语义按"是否致命"决定：致命返 terminal 短路；非致命降级继续
  //    - 不感知 caller 路径，纯粹按"turn 结束做什么"思考

  return { kind: "ok", messages };
}

// ─── ContextTermination → AgentResult 映射 ───

/**
 * 把 context/termination.ts 的判别联合映射到 agent-loop 的 AgentResult。
 *
 * 映射规则：
 *   - kind="ok"      → undefined（非终止，调用方继续流程）
 *   - kind="error"   → { reason: "error", error, usage }
 *   - kind="aborted" → { reason: "aborted", usage }（abortReason 由 finalizeRun 补提）
 *
 * 返回 undefined 而非省略 ok 分支：保持 switch 的类型穷尽性（ContextTermination
 * 加 kind 时 tsc 会报未穷尽错误），避免未来新增 kind 悄悄漏处理。
 *
 * usage 参数：当前 run 累积 usage —— 终止 AgentResult 需要带 usage 让订阅方统计消耗。
 *
 * abortReason / exitDelayMs 不在此处填充 —— finalizeRun 是单点退出 + 单点 abort
 * 优先转换，任何 aborted result 经过 finalizeRun 都会从 controller 补提 abortReason
 * 并算出 exitDelayMs。本函数只做协议层形状映射，不感知 abort 时间数据。
 */
function toTerminalAgentResult(
  termination: ContextTermination,
  usage: TokenUsage,
): AgentResult | undefined {
  switch (termination.kind) {
    case "ok":
      return undefined;
    case "error":
      return { reason: "error", error: termination.error, usage };
    case "aborted":
      return { reason: "aborted", usage };
  }
}
