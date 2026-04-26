/**
 * executeToolCalls — 工具执行子生成器
 *
 * 职责：
 * 1. 逐个执行 LLM 请求的工具调用
 * 2. 将 tool_start / tool_end 事件 yield 给消费者
 * 3. 通过 EventBus 发射工具执行事件
 * 4. 错误隔离：单个工具失败不终止循环，错误作为 tool_result 返回给 LLM
 *
 * 已实现的管线步骤：
 * - 结果截断（maxResultChars）—— 防止单个工具输出撑爆上下文
 *
 * 未来扩展点（不修改当前代码）：
 * - 并行执行 isParallelSafe 的工具
 * - 权限检查中间件
 * - 执行超时
 */

import type { IEventBus } from "../events/types.js";
import type { AgentEventMap } from "../types/agent-events.js";
import { isUserFacingError } from "../types/errors.js";
import type { LLMRoles } from "../types/llm.js";
import type { ToolResultBlock, ToolUseBlock } from "../types/messages.js";
import type { ToolDefinition, ToolExecutionContext } from "../types/tools.js";
import type { AgentLoopDeps, AgentYield } from "./types.js";

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
 * return: ToolResultBlock[]（与输入 toolCalls 一一对应）
 */
export async function* executeToolCalls(
  params: ExecuteToolCallsParams,
): AsyncGenerator<AgentYield, ToolResultBlock[]> {
  const {
    toolCalls,
    tools,
    deps,
    workingDirectory,
    abortSignal,
    eventBus,
    llmRoles,
  } = params;

  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const results: ToolResultBlock[] = [];

  for (const call of toolCalls) {
    const tool = toolMap.get(call.name);

    yield { type: "tool_start", id: call.id, name: call.name, input: call.input };

    await eventBus?.emit("tool:call_start", {
      id: call.id,
      name: call.name,
      input: call.input,
    });

    const startTime = Date.now();

    if (!tool) {
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
    } catch (err) {
      const duration = Date.now() - startTime;
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

  return results;
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

import type { ToolResult } from "../types/tools.js";

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
