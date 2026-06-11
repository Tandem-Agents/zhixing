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
 * 历史上 turn 结束副作用散落在 agent-loop 主循环里手写多遍，加新 turn 结束
 * 副作用必须同步改所有触发点。本钩子把这个语义提升为单点 —— turn 结束做什么，
 * 看这一个函数即可。
 *
 * ─── 钩子职责 ───
 *
 *   - attention-driven 切段（SegmentManager / 注意力阈值触发，唯一压缩机制）
 *     —— {@link runTurnBegin}（首个 LLM 调用前一次性）跑同一评估；
 *     它自带 inline（不与本处抽公共 helper，理由见 runTurnBegin 注释）。
 *   - 上下文 tokens 快照 emit（estimator + eventBus 注入时）
 *   - 注意力窗口换代触发（切段重构 messages 后通知 windowLifecycle）
 *   - 未来扩展：metrics / persistence checkpoint / per-turn 任意副作用
 *
 * 副作用按声明顺序串行执行，前者修改的 messages 自动流入后者。
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

import type { ITokenEstimator } from "../context/types.js";
import type { SegmentManager } from "../context/segment/segment-manager.js";
import type { IEventBus } from "../events/types.js";
import type { AgentEventMap } from "../types/agent-events.js";
import type { TokenUsage } from "../types/llm.js";
import type { Message } from "../types/messages.js";
import { toToolSpec, type ToolSpec } from "../types/tools.js";
import type { ToolDefinition } from "../types/tools.js";
import type {
  AgentResult,
  TokenAnchor,
  WindowChangeReason,
  WindowLifecycle,
} from "./types.js";

// ─── 输出 ───

/**
 * 钩子返回值 —— 判别联合。
 *
 *   - kind="ok"       → 副作用全部完成，messages 是最终版本（可能被改写）
 *   - kind="terminal" → 某个副作用要求终止 run，caller 据此调 finalizeRun
 */
export type TurnEndOutcome =
  | {
      readonly kind: "ok";
      readonly messages: Message[];
    }
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

  /** attention-driven 段切换（可选；缺省时段切换步骤静默 no-op） */
  readonly segmentManager?: SegmentManager;
  /**
   * 段切换 LLM 调用必要：保 cache prefix byte-equal。
   * 同时也是 ③ tokens 快照估算的 system 部分输入。
   */
  readonly systemPrompt: string;
  /**
   * 段切换 LLM 调用必要：保 cache prefix byte-equal。
   * 同时也是 ③ tokens 快照估算的 tools 部分输入。
   */
  readonly tools: readonly ToolDefinition[];
  /** 段切换 ephemeral 路径判定（缺省 → SegmentManager 内部静默 pass） */
  readonly conversationId?: string;

  /**
   * Token 估算器 —— ③ tokens 快照 emit 的依赖。
   *
   * 缺省时静默跳过快照 emit（与 segmentManager 缺失同模式）；不影响其他副作用。
   *
   * 复用 agent-loop 已有的 tokenEstimator（用于 per-LLM-call 校准）。
   */
  readonly tokenEstimator?: ITokenEstimator;
  /**
   * 事件总线 —— ③ tokens 快照通过它 emit "context:tokens_snapshot"。
   *
   * 与 tokenEstimator 一起缺省 → 快照 emit 整体跳过。任一缺失即静默 no-op，
   * 不报错、不警告（订阅方应能容忍事件不到达）。
   */
  readonly eventBus?: IEventBus<AgentEventMap>;
  /**
   * Token 真值锚点 —— ③ tokens 快照优先用 anchor + delta 路径替代纯字符估算。
   *
   * 缺省（首次 LLM call 之前）或失效（段切段 / 压缩后 messages.length < baseline）
   * 时 ③ 步降级到纯字符估算路径（estimator 全量加总），失效契约由 computeContextTokens
   * 内化处理，调用方无需感知。详见 {@link TokenAnchor}。
   */
  readonly anchor?: TokenAnchor;
  /**
   * 注意力窗口换代回调 —— 本 turn 发生段切换（messages 重构=新窗
   * 诞生）时，在 messages 重构完成后由本钩子**内部**触发。装配方（orchestrator）
   * 注入，据此重建 per-run 局部 prompt + 更新实例权威 prompt。缺省（sub-agent /
   * 单测）→ no-op。
   *
   * 触发收敛进本钩子（与 ③ tokens 快照 emit 同模式）、而非返回信号交 caller 各
   * 路径自行触发 —— 保证「所有 messages 重构出口都触发换代」一条不漏:runTurnEnd
   * 的纯文本末轮与工具路径同走本函数、同样覆盖,从结构上消除"某路径漏触发"。
   */
  readonly windowLifecycle?: WindowLifecycle;
}

// ─── Turn 开始钩子（首个 LLM 调用前一次性，只 ②） ───

/**
 * runTurnBegin 入参 —— 仅 ② 段切换所需子集。
 *
 * 刻意比 TurnEndParams 窄：runTurnBegin 不需要 usage /
 * tokenEstimator / eventBus / anchor(③)，签名不对调用方"撒谎"需要这些。
 * messages 取 `readonly` —— 直接接受 agent-loop 的 state.messages
 * （`readonly Message[]`），调用方无需先拷贝。
 */
export interface SegmentSwitchParams {
  readonly segmentManager?: SegmentManager;
  readonly messages: readonly Message[];
  readonly systemPrompt: string;
  readonly tools: readonly ToolDefinition[];
  readonly turnCount: number;
  readonly conversationId?: string;
  readonly abortSignal: AbortSignal;
  /** 注意力窗口换代回调 —— 段切换后内部触发(同 runTurnEnd)。缺省 → no-op。 */
  readonly windowLifecycle?: WindowLifecycle;
}

/**
 * Turn 开始（首个 LLM 调用前）一次性段切换评估 —— 与 runTurnEnd 对称但**只跑 ②**。
 *
 * 为何只 ②：
 *   - turn 完成语义的副作用（tokens 快照等）turn 开始时无
 *     已完成 turn、initial messages 非 user/assistant 配对，调它违反钩子契约
 *     （契约由 agent-loop P0-F/P0-L 测试守护）。① 留 turn-end。
 *   - ③ tokens 快照属 turn 结束语义，且首个 call 前 anchor 必缺。
 *   - ② `segmentManager.evaluate` 是无状态"当前上下文是否超注意力窗口"评估，
 *     首调前完全合法，且正是真实需求：恢复的持久对话 / 首条超大输入超注意力
 *     窗口时，在第一次 streamLLMCall 前就压缩，而非先吃一个超窗口 turn 再
 *     turn-end 自愈。② optimal 阈值是最早触发点（attention ≪ budget ≪ 硬窗口），
 *     单跑 ② 已足以避免超窗口首调。
 *
 * 为何不与 runTurnEnd 的 ② 抽公共 helper：② 仅一次 evaluate 调用 + 一个三元；
 * 且 turn-end 在 `Message[]`、turn-begin 在 `readonly Message[]` 上工作（数组
 * 变体不同），强抽公共签名反而要 cast/拷贝。本文件 header 明示的 YAGNI 训诫下，
 * 两处各自 inline 的 ~6 行更清晰，无隐式抽象债。
 *
 * 无条件每 run 一次（caller 放在循环外保证）；未超阈是廉价 no-op（纯估算+比较，
 * 无 LLM）。永不 terminal（evaluate 内部已吞失败返 modified:false）。返回处理后的
 * messages（no-op 路径浅拷贝 readonly 入参为 mutable，每 run 仅一次，成本可忽略）。
 * 段切换时窗口换代由本函数**内部**触发 windowLifecycle.onChange（在返回前、首个
 * LLM call 之前），与 runTurnEnd 同模式 —— caller 拿到的就是已重建好的窗口。
 */
export async function runTurnBegin(
  params: SegmentSwitchParams,
): Promise<{ messages: Message[] }> {
  if (!params.segmentManager) return { messages: [...params.messages] };
  const seg = await params.segmentManager.evaluate({
    messages: params.messages,
    systemPrompt: params.systemPrompt,
    tools: params.tools.map(toToolSpec),
    turnCount: params.turnCount,
    conversationId: params.conversationId,
    abortSignal: params.abortSignal,
  });
  if (seg.modified && seg.newSegmentMessages) {
    await params.windowLifecycle?.onChange("segment-transition");
    return { messages: seg.newSegmentMessages };
  }
  return { messages: [...params.messages] };
}

// ─── 钩子 ───

/**
 * 执行 turn 结束副作用编排。
 *
 * 串行顺序：段切换 → tokens 快照 → 窗口换代触发；未来副作用在此追加，
 * 保持 messages 链式传递。
 *
 * 失败语义：segmentManager 失败 → SegmentManager 内部已捕获并按终态分流
 * （终态失败 emit transition_failed；风险档由应急地板机械兜底、以降级方式
 * 完成），返回 modified=false 时钩子拿原 messages 继续 —— 段切换失败绝不
 * 阻塞 turn。
 */
export async function runTurnEnd(
  params: TurnEndParams,
): Promise<TurnEndOutcome> {
  let messages = params.messages;
  let windowChange: WindowChangeReason | undefined;

  // attention-driven 段切换（唯一压缩机制）
  //
  // marker 走 segment:new_started 事件 → orchestrator accumulator → 随
  // RunResult 带出，由会话层在接受协议中折叠窗口（不落 transcript——
  // 压缩是窗口的视图操作，原文持久化 append-only 不参与）。
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
      windowChange = "segment-transition";
    }
  }

  // 上下文 tokens 快照 emit
  //
  // 反映"下次 LLM 将看到的"上下文占用 —— 必须在切段处理之后估算，让快照与
  // 真实 LLM 视图一致。
  //
  // 与 segment:evaluation.currentTokens 的关系：后者是评估副产物（仅 SegmentManager
  // 装配时 emit），本事件是占用快照的一等公民信号（不依赖 SegmentManager）。
  // 订阅方（UI 上下文指示器 / 诊断面板）应订阅 context:tokens_snapshot，不要
  // 依赖 segment:evaluation 推断占用。
  //
  // 估算路径决策由 computeContextTokens 单点封装：
  //   - anchor 可用 → "已发送部分用 API 真值 + 新增 delta 字符估算"，业界推测
  //     Claude Code 同模式，误差从纯字符估算的 ±20-80% 降到 ±5-15%
  //   - anchor 失效或缺失 → 纯字符估算 fallback，使用 estimator EMA 校准的 factor
  //
  // 静默语义：tokenEstimator / eventBus 任一缺失即跳过（与 segmentManager
  // 缺失同模式）；订阅方应能容忍事件不到达。
  if (params.tokenEstimator && params.eventBus) {
    const totalTokens = computeContextTokens({
      estimator: params.tokenEstimator,
      systemPrompt: params.systemPrompt,
      messages,
      tools: params.tools.map(toToolSpec),
      anchor: params.anchor,
    });
    await params.eventBus.emit("context:tokens_snapshot", {
      totalTokens,
      turnCount: params.turnCount,
    });
  }

  // 注意力窗口换代触发 —— 本 turn 的切段重构了 messages = 新注意力窗口诞生,
  //    在此(messages 已最终化、下个 LLM call 之前)通知 windowLifecycle 做窗口边界
  //    重建。收敛于此、而非返回信号交 caller 各路径自行触发:runTurnEnd 的所有调用
  //    路径(纯文本末轮 / 工具路径)都经本函数,「所有 messages 重构出口都触发换代」
  //    从结构上一条不漏。缺省 windowLifecycle(sub-agent / 单测)→ no-op。
  if (windowChange) {
    await params.windowLifecycle?.onChange(windowChange);
  }

  // ⑤ 未来扩展点 —— 新副作用直接在此追加：
  //    - 复用上方 messages 变量（链式传递）
  //    - 失败语义按"是否致命"决定：致命返 terminal 短路；非致命降级继续
  //    - 不感知 caller 路径，纯粹按"turn 结束做什么"思考

  return { kind: "ok", messages };
}

// ─── tokens 快照计算 ───

interface ContextTokensInput {
  readonly estimator: ITokenEstimator;
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolSpec[];
  readonly anchor: TokenAnchor | undefined;
}

/**
 * 计算"下次 LLM 将看到的上下文总 token 数"—— anchor + delta / fallback 字符估算双路径。
 *
 * ─── 路径决策 ───
 *
 *   Anchor 可用（首次 LLM call 之后 + messages 是 anchor 时刻的延伸）：
 *     return anchor.inputTokens + estimator.estimateMessages(messages.slice(baseline))
 *     - 已发送部分按 API 真值锚定（100% 精确）
 *     - 仅自 anchor 以来新增的 messages 后缀做字符估算（增量字节小，绝对误差小）
 *
 *   Anchor 缺失（首次 LLM call 之前）/ 失效（段切段 / 压缩让 messages 缩到比 baseline 短）：
 *     return estimateText(system) + estimateMessages(messages) + estimateTools(tools)
 *     - 三件套全量字符估算 + estimator EMA 校准 factor
 *     - 失效语义靠 `messages.length < anchor.baselineMessageCount` 自然降级，
 *       不需要主动 invalidate —— 下一次 LLM call 成功又会基于新 length 写新 anchor
 *
 * ─── 为什么这个 helper 单独抽出 ───
 *
 * - turn-end 钩子主流程只关心"决定 emit 什么 totalTokens"，路径决策细节内化在此
 *   单点，避免 ③ 步与主控制流耦合
 * - 单一职责 + 纯函数：输入完整、无副作用、易测试（直接断言返回值）
 * - 未来若再加估算路径（如 deepseek-tokenizer 真值），扩展点收敛于此函数体内的
 *   `if-else if-fallback` 链，钩子主流程零改动
 *
 * ─── Anchor 路径的残余误差源 ───
 *
 * - anchor.inputTokens 含本次 LLM call 注入的 turn-context block 字节（~100-300
 *   token），下次估算 `anchor.inputTokens + delta` 时物理上重复计了这部分 ——
 *   业界共识可接受的小高估（< 5%），不做"减去注入字节"的精细修正（YAGNI）
 * - delta 部分的字符估算用 estimator factor，仍受字符权重 ±10% 的天然偏差，
 *   但增量字节小所以绝对误差可控
 */
function computeContextTokens(input: ContextTokensInput): number {
  const { estimator, systemPrompt, messages, tools, anchor } = input;

  // Anchor 路径 —— 已发送部分按真值锚定
  if (anchor && messages.length >= anchor.baselineMessageCount) {
    const delta = messages.slice(anchor.baselineMessageCount);
    return anchor.inputTokens + estimator.estimateMessages(delta);
  }

  // Fallback —— 纯字符估算（首次 LLM call 之前 / anchor 失效）
  return (
    estimator.estimateText(systemPrompt) +
    estimator.estimateMessages(messages) +
    estimator.estimateTools(tools)
  );
}
