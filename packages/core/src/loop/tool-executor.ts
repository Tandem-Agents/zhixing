/**
 * executeToolCalls — 工具执行子生成器
 *
 * 职责：
 * 1. 逐个执行 LLM 请求的工具调用
 * 2. 将 tool_start / tool_end 事件 yield 给消费者
 * 3. 通过 EventBus 发射工具执行事件
 * 4. 错误隔离：单个工具失败不终止循环，错误作为 tool_result 返回给 LLM
 * 5. abort 响应：循环顶 + 工具退出后均检查 abort，未执行 tool_use 由 cleanup 注入 placeholder
 *更新：
 * 1. 按 toolCalls 分组判断:全 isParallelSafe=true 且 N≥2 → 走并发分支;否则走串行分支
 * 2. 串行分支:逐个执行,完整保留现有 yield / event / abort / cleanup 协议
 * 3. 并发分支:Promise.allSettled 真并发;tool_start 同步全发(启动信号),
 *    tool_end 按输入顺序逐个 yield(保主 LLM 看到的 tool_result 顺序)
 * 4. 错误隔离:单工具失败不终止 batch,错误作为 isError tool_result 返回
 * 5. abort 响应:串行循环顶 + 工具退出后 check;并发分支入口先 check 再启动批次
 *
 * 已实现的管线步骤：
 * - 结果截断（maxResultChars）—— 防止单个工具输出撑爆上下文
 *
 * 中断架构（串行 / 并发共用契约）：
 *
 * - **per-iter abort guard（串行）**：循环最前 + 工具完成后均 check signal.aborted。前者防止已
 *   aborted 时再消耗任何工具；后者保证当前工具完成的合规 result 一定进入 completedResults
 *   (否则 abort 时丢 result 会让 LLM 在下一轮看不到该工具已执行,可能重发同 tool_use 引发
 *   幂等性破坏 —— 写类工具会重复写)。
 *
 * - **entry abort guard（并发）**：批次启动前 check signal.aborted,已 aborted 则不发任何
 *   tool_start,所有 tool_use 直接进 unexecutedToolUses(单一事实源:cleanup 注 placeholder)。
 *
 * - **abortedDuringToolAt 跟踪**：串行模式记 abort 发生在工具 await 期间的退出时刻
 *   `performance.now()`；并发模式因 N 个工具几乎同时响应 abort,用 `Promise.allSettled` 等齐
 *   时刻作"整批退出时刻"代理,语义上 ≈ max(所有工具 abort 退出时刻),与串行 per-tool 时刻贴近。
 *   agent-loop 据此与 abortFiredAt 计算 `toolGraceMs = max(0, abortedDuringToolAt - abortFiredAt)`，
 *   反映"工具自身 abort 等待消耗"，让 SLO 监控能精确隔离 loop 框架延迟与工具自身延迟。
 *
 * - **工具未找到分支保持现有 isError 路径**：不进入 unexecutedToolUses，直接合成 isError
 *   tool_result 继续下一个 (这不是 abort 触发，无需 cleanup)。
 *
 * - **return shape 是 ExecuteToolCallsResult**：暴露 unexecutedToolUses 列表 (保留完整
 *   ToolUseBlock 含 id/name/input)，由 cleanup 模块统一注入 placeholder —— 单一事实源。
 *
 * 并发分支与串行分支的契约对等(及顺序契约的精确边界):
 *   - 非 abort 路径(完整 turn / 单工具 throw 但 batch 整体跑完):tool_result 严格
 *     按 tool_use 输入顺序进 user message,与串行模式 byte-equal
 *   - abort 中途 + 工具响应不一致(部分 fulfilled 部分 reject AbortError)的混合
 *     场景:fulfilled 按输入顺序 yield 在前,abort placeholder 由 cleanup 在末尾按
 *     unexecutedToolUses 顺序追加 → user message 顺序 = "fulfilled 子集 ++ abort 子集",
 *     **不严格 byte-equal 串行模式**。Anthropic / OpenAI provider 按 tool_use_id /
 *     tool_call_id 匹配 tool_result,顺序无关,API 不报错 + LLM 推理无影响 +
 *     transcript rebuild 按 ID 匹配持久化无回归;且 Task 工具内部 parentSignal 链
 *     自动级联,abort 时几乎全 reject(顺序不变),Read/Glob/Grep 几乎全 fulfilled
 *     reject 极罕见,产品现实场景几乎不出现混合形态 —— 故有意保留当前简洁实现
 *     (强行重排需改 cleanup 跨模块边界,无产品收益)
 *   - cleanup placeholder 路径单一事实源不变(catch 块 abort / allSettled abort
 *     reject 不 yield tool_end,统由 unexecutedToolUses 走 cleanup 注 placeholder,
 *     避免同 tool_use 双 result 进 user message → API 400)
 *   - 错误隔离不变(非 abort throw → isError tool_result + yield tool_end + emit)
 *   - 工具未注册 / N=1 / 含 unsafe 自动回退串行,行为零差异
 */

import type { IEventBus } from "../events/types.js";
import type { AgentEventMap } from "../types/agent-events.js";
import { isUserFacingError } from "../types/errors.js";
import type { LLMRoles } from "../types/llm.js";
import type { ToolResultBlock, ToolUseBlock } from "../types/messages.js";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from "../types/tools.js";
import type {
  AgentLoopDeps,
  AgentYield,
  ExecuteToolCallsResult,
} from "./types.js";

interface ExecuteToolCallsParams {
  toolCalls: ToolUseBlock[];
  tools: ToolDefinition[];
  deps: AgentLoopDeps;
  workingDirectory: string;
  abortSignal?: AbortSignal;
  eventBus?: IEventBus<AgentEventMap>;
  /**
   * 会话级 LLM 角色集合，注入到每次 tool.call 的 ctx.llm。可选——单测路径
   * 可不传，consumer 必须显式分支处理 !ctx.llm（见 ToolExecutionContext.llm 注释）。
   */
  llmRoles?: LLMRoles;
}

/**
 * 执行一批工具调用。
 *
 * yield: tool_start / tool_end
 * return: ExecuteToolCallsResult (含 completedResults / unexecutedToolUses /
 *   abortedDuringToolAt)
 *
 * 分组策略(本函数唯一外部 API,实际批次执行委托给 runSerialBatch / runParallelBatch):
 *   - N≥2 且 toolCalls 全部 isParallelSafe===true 且工具均已注册 → runParallelBatch
 *   - 其他(N=1 / 含 unsafe / 含未注册工具) → runSerialBatch(完全保留现有逻辑)
 */
export async function* executeToolCalls(
  params: ExecuteToolCallsParams,
): AsyncGenerator<AgentYield, ExecuteToolCallsResult> {
  const toolMap = new Map(params.tools.map((t) => [t.name, t]));

  if (canRunParallel(toolMap, params.toolCalls)) {
    return yield* runParallelBatch(params, toolMap);
  }

  return yield* runSerialBatch(params, toolMap);
}

/**
 * 串行批次执行 —— 现有 yield/event/abort 协议的权威实现。
 *
 * 进入条件:N=1 / 含 isParallelSafe!==true 工具 / 含未注册工具(toolMap.get 返回 undefined)。
 */
async function* runSerialBatch(
  params: ExecuteToolCallsParams,
  toolMap: Map<string, ToolDefinition>,
): AsyncGenerator<AgentYield, ExecuteToolCallsResult> {
  const {
    toolCalls,
    deps,
    workingDirectory,
    abortSignal,
    eventBus,
    llmRoles,
  } = params;

  const results: ToolResultBlock[] = [];
  // abort 触发的中断点 (toolCalls 索引)；null 表示无 abort，全部完整执行
  let abortedAtIndex: number | null = null;
  // abort 发生在工具 await 期间时记退出时刻；abort 发生在循环顶 (工具间隙) 时为 undefined
  let abortedDuringToolAt: number | undefined;

  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i]!;

    // 循环顶 abort guard —— abort 发生在工具间隙 (前一工具完成后、本工具开始前)。
    // 比"工具未找到"分支早，保证已 aborted 时不再消耗任何工具。
    // 不记 abortedDuringToolAt —— loopFrameworkDelay 全归 loop 框架。
    if (abortSignal?.aborted) {
      abortedAtIndex = i;
      break;
    }

    const tool = toolMap.get(call.name);

    yield { type: "tool_start", id: call.id, name: call.name, input: call.input };

    await eventBus?.emit("tool:call_start", {
      id: call.id,
      name: call.name,
      input: call.input,
    });

    const startTime = Date.now();

    if (!tool) {
      // 工具未找到分支保持现有 isError tool_result 路径——不是 abort 触发，
      // 不进 unexecutedToolUses，直接合成 isError 结果继续下一个
      const errorContent = `Tool "${call.name}" not found. Available tools: ${[...toolMap.keys()].join(", ")}`;
      const duration = Date.now() - startTime;

      results.push({
        type: "tool_result",
        toolUseId: call.id,
        content: errorContent,
        isError: true,
      });

      const result = { content: errorContent, isError: true };

      yield { type: "tool_end", id: call.id, name: call.name, result, duration };

      await eventBus?.emit("tool:call_end", {
        id: call.id,
        name: call.name,
        duration,
        success: false,
        resultSize: errorContent.length,
      });

      continue;
    }

    const context: ToolExecutionContext = {
      workingDirectory,
      abortSignal,
      llm: llmRoles,
    };

    try {
      const rawResult = await deps.executeTool(tool, call.input, context);
      const duration = Date.now() - startTime;

      // 管线步骤：结果截断
      const toolResult = applyMaxResultChars(rawResult, tool.maxResultChars);

      // ADR-007 Phase 2：ToolResult.committedToUser 字段无法通过 LLM 消息协议传递
      // （ToolResultBlock 只支持 content/isError）。因此把该标记编码到 content
      // 文本尾部，成为 LLM 可见的信号。系统提示中对应规则识别该标记以抑制叙述。
      const contentForLLM = toolResult.committedToUser
        ? `${toolResult.content}\n\n${COMMITMENT_SIGNAL}`
        : toolResult.content;

      // 当前工具完成的合规 result 必须进 completedResults (在 abort check 之前 push) ——
      // 否则 abort 时丢 result 会让 LLM 在下一轮看不到该工具已执行，可能重发同 tool_use
      // 引发幂等性破坏 (写类工具会重复写)
      results.push({
        type: "tool_result",
        toolUseId: call.id,
        content: contentForLLM,
        isError: toolResult.isError,
      });

      yield { type: "tool_end", id: call.id, name: call.name, result: toolResult, duration };

      await eventBus?.emit("tool:call_end", {
        id: call.id,
        name: call.name,
        duration,
        success: !toolResult.isError,
        resultSize: toolResult.content.length,
      });

      if (abortSignal?.aborted) {
        // 工具响应 abort 后正常 return (可能 partial output)；当前工具的合规 result 已 push,
        // unexecutedToolUses 从下一个开始
        abortedDuringToolAt = performance.now();
        abortedAtIndex = i + 1;
        break;
      }
    } catch (err) {
      const duration = Date.now() - startTime;

      if (abortSignal?.aborted) {
        // 工具响应 abort 抛 AbortError —— 当前工具不合成 result，由 cleanup 在
        // agent-loop 那一层为 unexecutedToolUses (含本工具) 注入唯一 placeholder。
        // **不在此 yield/emit tool_end** —— 否则与 cleanup placeholder 重复，
        // 同一 tool_use 会有两个 tool_result 进 user message，违反 messages 协议
        // (Anthropic API 报 400)。单一事实源:abort 触发的所有 placeholder 由 cleanup 出。
        abortedDuringToolAt = performance.now();
        abortedAtIndex = i;
        break;
      }

      const errorMessage = err instanceof Error ? err.message : String(err);

      // 关键：区分"工具内部故障"和"用户面向错误"。
      //
      // 用户面向错误（如 SecurityBlockError 携带的 "用户拒绝此操作。反馈：
      // 不要用 rm"）已经是一段完整、model-friendly 的反馈——直接原样作为
      // tool_result 回送给 LLM，模型据此调整行为。
      //
      // 工具内部故障（JavaScript 异常、SDK 错误等）则加 "Tool execution
      // failed: " 前缀，帮模型区分"我做错了"和"用户不同意"。
      const errorContent = isUserFacingError(err)
        ? errorMessage
        : `Tool execution failed: ${errorMessage}`;

      results.push({
        type: "tool_result",
        toolUseId: call.id,
        content: errorContent,
        isError: true,
      });

      const result = { content: errorContent, isError: true };

      yield { type: "tool_end", id: call.id, name: call.name, result, duration };

      await eventBus?.emit("tool:call_end", {
        id: call.id,
        name: call.name,
        duration,
        success: false,
        resultSize: errorContent.length,
      });
    }
  }

  return {
    completedResults: results,
    unexecutedToolUses:
      abortedAtIndex !== null ? toolCalls.slice(abortedAtIndex) : [],
    abortedDuringToolAt,
  };
}

/**
 * 并发分组判断 —— N≥2 且 toolCalls 全部 isParallelSafe===true 且工具均已注册。
 *
 * 设计理由:
 *   - N=1:并发原语(Promise.allSettled)无收益,直接走串行避免开销
 *   - 含 isParallelSafe!==true:fail-closed,任一 unsafe 整批回退串行
 *     (不做局部并发分组,因为顺序读写依赖难以静态推断,Edit 后的 Read 必须看到新内容)
 *   - 含未注册工具(toolMap.get 返回 undefined):走串行让"工具未找到"分支合成 isError result
 *     —— 不在并发分支重复实现这个错误路径
 */
function canRunParallel(
  toolMap: Map<string, ToolDefinition>,
  toolCalls: ToolUseBlock[],
): boolean {
  if (toolCalls.length < 2) return false;
  return toolCalls.every((c) => toolMap.get(c.name)?.isParallelSafe === true);
}

/**
 * 并发批次执行 —— Promise.allSettled 真并发,兑现"3 Task 并发跑"产品语义。
 *
 * 与串行分支的契约对等(避免主 LLM 看到协议漂移):
 *   - tool_start 同步先全发(N 个,按输入顺序),再启动 N 个 promise
 *     —— 启动信号给状态条 / RPC 订阅者,主 LLM 仍只看 tool_result 集
 *   - allSettled 等齐后按输入顺序遍历:fulfilled / 非 abort error → yield tool_end +
 *     emit + 累积 results;abort reject → 进 unexecutedToolUses 不 yield(单一事实源
 *     由 cleanup 注 placeholder)
 *   - 非 abort throw → isError tool_result + yield tool_end(错误隔离)
 *   - 入口 abort guard:已 aborted 时不发 tool_start / 不启动 promise,全部进 unexecutedToolUses
 *
 * tool_result 顺序契约的精确边界(详见模块顶部 JSDoc):
 *   - 非 abort 路径:严格按 tool_use 输入顺序进 user message,与串行 byte-equal
 *   - abort 中途混合(部分 fulfilled / 部分 reject)路径:fulfilled 子集按输入顺序在前,
 *     placeholder 子集在末尾按 unexecutedToolUses 顺序追加 —— provider 按 tool_use_id
 *     匹配,API 与 LLM 推理无影响,有意保留(强行重排无产品收益,需改 cleanup 跨模块)
 *
 * abortedDuringToolAt:并发模式记 allSettled 等齐时刻作"整批退出时刻"代理,
 *   语义 ≈ max(所有工具响应 abort 退出时刻),与串行 per-tool 时刻贴近。
 *   agent-loop 用此值算 toolGraceMs 反映"工具自身 abort 等待消耗"。
 */
async function* runParallelBatch(
  params: ExecuteToolCallsParams,
  toolMap: Map<string, ToolDefinition>,
): AsyncGenerator<AgentYield, ExecuteToolCallsResult> {
  const {
    toolCalls,
    deps,
    workingDirectory,
    abortSignal,
    eventBus,
    llmRoles,
  } = params;

  // 入口 abort guard:与串行循环顶 guard 等价,但批次粒度
  // (并发模式不存在"前 K 个完成 + 后续未启动"边界,所以入口 check 一次即可)
  if (abortSignal?.aborted) {
    return {
      completedResults: [],
      unexecutedToolUses: [...toolCalls],
      abortedDuringToolAt: undefined,
    };
  }

  // tool_start 同步全发(批次启动可见性,顺序 = 输入顺序)
  for (const call of toolCalls) {
    yield { type: "tool_start", id: call.id, name: call.name, input: call.input };
    await eventBus?.emit("tool:call_start", {
      id: call.id,
      name: call.name,
      input: call.input,
    });
  }

  // 共享 ctx:并发模式下 N 个工具共享同一 workingDirectory / abortSignal / llm 引用,
  // 与串行模式 per-call 新建 ctx 的引用语义等价(三个字段均不应被工具内部 mutate)
  const ctx: ToolExecutionContext = {
    workingDirectory,
    abortSignal,
    llm: llmRoles,
  };

  const startTime = Date.now();
  const settled = await Promise.allSettled(
    toolCalls.map((call) => {
      // canRunParallel 已保证 toolMap.get(call.name) 命中且 isParallelSafe=true
      const tool = toolMap.get(call.name)!;
      return deps.executeTool(tool, call.input, ctx);
    }),
  );
  const settledAt = performance.now();
  const duration = Date.now() - startTime;

  // 按输入顺序遍历结果 → yield tool_end + emit + 累积 results / unexecutedToolUses
  const results: ToolResultBlock[] = [];
  const unexecutedToolUses: ToolUseBlock[] = [];
  let abortedDuringToolAt: number | undefined;

  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i]!;
    const tool = toolMap.get(call.name)!;
    const outcome = settled[i]!;

    if (outcome.status === "fulfilled") {
      const toolResult = applyMaxResultChars(outcome.value, tool.maxResultChars);
      const contentForLLM = toolResult.committedToUser
        ? `${toolResult.content}\n\n${COMMITMENT_SIGNAL}`
        : toolResult.content;

      results.push({
        type: "tool_result",
        toolUseId: call.id,
        content: contentForLLM,
        isError: toolResult.isError,
      });

      yield {
        type: "tool_end",
        id: call.id,
        name: call.name,
        result: toolResult,
        duration,
      };

      await eventBus?.emit("tool:call_end", {
        id: call.id,
        name: call.name,
        duration,
        success: !toolResult.isError,
        resultSize: toolResult.content.length,
      });
      continue;
    }

    // outcome.status === "rejected"
    const err = outcome.reason;

    // abort 路径:与串行 catch 块 abort 同语义 —— 不 yield tool_end,进 unexecutedToolUses
    // 由 cleanup 注唯一 placeholder(避免同 tool_use 双 result → API 400)
    //
    // 判断时机:allSettled 等齐后 abortSignal 必已显式 aborted(若是 abort 触发的 reject);
    // 工具内部非 abort 异常的 reject,signal 未 aborted,走 isError 路径
    if (abortSignal?.aborted) {
      abortedDuringToolAt = settledAt;
      unexecutedToolUses.push(call);
      continue;
    }

    // 非 abort throw → isError tool_result(C6 错误隔离)
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorContent = isUserFacingError(err)
      ? errorMessage
      : `Tool execution failed: ${errorMessage}`;

    results.push({
      type: "tool_result",
      toolUseId: call.id,
      content: errorContent,
      isError: true,
    });

    const result: ToolResult = { content: errorContent, isError: true };

    yield { type: "tool_end", id: call.id, name: call.name, result, duration };

    await eventBus?.emit("tool:call_end", {
      id: call.id,
      name: call.name,
      duration,
      success: false,
      resultSize: errorContent.length,
    });
  }

  return {
    completedResults: results,
    unexecutedToolUses,
    abortedDuringToolAt,
  };
}

// ─── 常量 ───

/**
 * 当 ToolResult.committedToUser=true 时，附加到 tool_result.content 尾部的 LLM 信号文本。
 * 系统提示（buildToolUsage）识别此文本时抑制 LLM 对该工具结果的叙述。
 * 参见 ADR-007 Phase 2 / [message-outbox.md §4.4](../../../../research/design/specifications/message-outbox.md)。
 */
export const COMMITMENT_SIGNAL =
  "[Commitment already sent to user. Do not restate.]";

// ─── 管线工具函数 ───

/**
 * 对工具结果应用 maxResultChars 截断。
 * 错误结果不截断（错误信息通常很短且对调试至关重要）。
 */
function applyMaxResultChars(
  result: ToolResult,
  maxChars: number | undefined,
): ToolResult {
  if (!maxChars || result.isError || result.content.length <= maxChars) {
    return result;
  }

  const truncated = result.content.slice(0, maxChars);
  const omitted = result.content.length - maxChars;

  return {
    ...result,
    content: `${truncated}\n\n[truncated: showing first ${maxChars.toLocaleString()} of ${result.content.length.toLocaleString()} chars, ${omitted.toLocaleString()} chars omitted]`,
  };
}
