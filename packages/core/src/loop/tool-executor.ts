/**
 * executeToolCalls — 工具执行子生成器
 *
 * 职责：
 * 1. 逐个执行 LLM 请求的工具调用
 * 2. 将 tool_start / tool_end 事件 yield 给消费者
 * 3. 通过 EventBus 发射工具执行事件
 * 4. 错误隔离：单个工具失败不终止循环，错误作为 tool_result 返回给 LLM
 *
 * 未来扩展点（不修改当前代码）：
 * - 并行执行 isParallelSafe 的工具
 * - 权限检查中间件
 * - 执行超时
 * - 结果截断（maxResultChars）
 */

import type { IEventBus } from "../events/types.js";
import type { AgentEventMap } from "../types/agent-events.js";
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
  const { toolCalls, tools, deps, workingDirectory, abortSignal, eventBus } = params;

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
    };

    try {
      const toolResult = await deps.executeTool(tool, call.input, context);
      const duration = Date.now() - startTime;

      results.push({
        type: "tool_result",
        toolUseId: call.id,
        content: toolResult.content,
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
      const errorContent = `Tool execution failed: ${errorMessage}`;

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
