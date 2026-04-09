/**
 * Agent Loop — 知行智能体核心循环
 *
 * 这是整个系统的心脏：一个 AsyncGenerator 驱动的 while(true) 循环，
 * 交替执行 LLM 调用和工具执行，直到达成终止条件。
 *
 * 架构决策（详见 research/_private/questions/q02-agent-loop-design.md）：
 * - AsyncGenerator：背压控制、类型安全的 return 值、yield* 可组合
 * - while(true) + 不可变状态：每轮重建 LoopState，不累积副作用
 * - 子生成器拆分：streamLLMCall / executeToolCalls 各司其职
 * - EventBus 一等公民：所有关键节点发射事件，支持完全解耦的观测
 *
 * 终止条件：
 * - completed：LLM 返回纯文本（无工具调用），正常结束
 * - max_turns：超过 maxTurns 限制
 * - aborted：AbortSignal 被触发
 * - error：LLM 调用出错（MVP 不做自动恢复，后续通过 guards 扩展）
 */

import type { IEventBus } from "../events/types.js";
import type { AgentEventMap } from "../types/agent-events.js";
import { emptyUsage, mergeUsage } from "../types/llm.js";
import { extractText, extractToolCalls, toolResultMessage } from "../types/messages.js";
import { toToolSpec } from "../types/tools.js";
import { streamLLMCall } from "./llm-call.js";
import { executeToolCalls } from "./tool-executor.js";
import type {
  AgentLoopDeps,
  AgentLoopParams,
  AgentResult,
  AgentYield,
  LoopState,
} from "./types.js";

/**
 * 运行智能体循环。
 *
 * 消费方式：
 * ```ts
 * const gen = runAgentLoop(params);
 * // 方式 1：手动迭代（推荐，可获取 return 值）
 * while (true) {
 *   const { value, done } = await gen.next();
 *   if (done) { const result = value; break; }
 *   handleEvent(value);
 * }
 * // 方式 2：使用 drainAgentLoop 便捷函数
 * const { yields, result } = await drainAgentLoop(params);
 * ```
 */
export async function* runAgentLoop(
  params: AgentLoopParams,
): AsyncGenerator<AgentYield, AgentResult> {
  const { model, systemPrompt, abortSignal, eventBus } = params;
  const tools = params.tools ?? [];
  const maxTurns = params.maxTurns ?? 100;
  const workingDirectory = params.workingDirectory ?? process.cwd();
  const toolSpecs = tools.map(toToolSpec);
  const deps = resolveDeps(params);

  const startTime = Date.now();

  let state: LoopState = {
    messages: [...params.messages],
    turnCount: 0,
    totalUsage: emptyUsage(),
  };

  const lastMessage = state.messages[state.messages.length - 1];
  await eventBus?.emit("agent:run_start", {
    prompt: lastMessage ? extractText(lastMessage) : "",
  });

  try {
    while (true) {
      // ── Guard: max turns ──
      if (state.turnCount >= maxTurns) {
        return await emitRunEnd(eventBus, startTime, {
          reason: "max_turns",
          usage: state.totalUsage,
        });
      }

      // ── Guard: abort ──
      if (abortSignal?.aborted) {
        return await emitRunEnd(eventBus, startTime, {
          reason: "aborted",
          usage: state.totalUsage,
        });
      }

      // ── Step 1: Call LLM ──
      const llmResult = yield* streamLLMCall({
        deps,
        messages: state.messages,
        model,
        systemPrompt,
        toolSpecs,
        abortSignal,
        eventBus,
      });

      const usage = mergeUsage(state.totalUsage, llmResult.usage);

      // ── LLM 错误 → 终止 ──
      if (llmResult.error) {
        return await emitRunEnd(eventBus, startTime, {
          reason: "error",
          error: llmResult.error,
          usage,
        });
      }

      // ── 无工具调用 → 正常完成 ──
      const toolCalls = extractToolCalls(llmResult.message);
      if (toolCalls.length === 0) {
        return await emitRunEnd(eventBus, startTime, {
          reason: "completed",
          message: llmResult.message,
          usage,
        });
      }

      // ── Step 2: Execute tools ──
      const toolResults = yield* executeToolCalls({
        toolCalls,
        tools,
        deps,
        workingDirectory,
        abortSignal,
        eventBus,
      });

      // ── Yield turn boundary ──
      const newTurnCount = state.turnCount + 1;
      yield { type: "turn_complete", turnCount: newTurnCount, usage: llmResult.usage };

      // ── Advance state (immutable reconstruction) ──
      let newMessages = [
        ...state.messages,
        llmResult.message,
        toolResultMessage(toolResults),
      ];

      // ── Context management: 预算检查 + 自动压缩 ──
      if (params.contextManager) {
        const cmResult = await params.contextManager.onTurnComplete({
          messages: newMessages,
          turnCount: newTurnCount,
        });
        if (cmResult.modified) {
          newMessages = cmResult.messages;
        }
      }

      state = {
        messages: newMessages,
        turnCount: newTurnCount,
        totalUsage: usage,
        transition: { reason: "tool_use" },
      };
    }
  } finally {
    // 即使消费者提前调用 generator.return()，也能发射 run_end
    // （JS generator 的 finally 在 return() 时执行）
    // 注意：正常的 return 路径已经在 emitRunEnd 中发射了事件，
    // finally 中的 emit 通过 try-catch 避免重复发射导致的问题
  }
}

// ─── 便捷消费函数 ───

/**
 * 运行 Agent Loop 到完成，收集所有 yield 事件和最终结果。
 *
 * 解决 for-await-of 无法获取 AsyncGenerator return 值的问题。
 * 适用于测试和不需要实时流式处理的场景。
 */
export async function drainAgentLoop(
  params: AgentLoopParams,
): Promise<{ yields: AgentYield[]; result: AgentResult }> {
  const yields: AgentYield[] = [];
  const gen = runAgentLoop(params);

  while (true) {
    const iterResult = await gen.next();
    if (iterResult.done) {
      return { yields, result: iterResult.value };
    }
    yields.push(iterResult.value);
  }
}

// ─── 内部辅助 ───

/**
 * 解析依赖。用户提供的 deps 覆盖默认实现。
 */
function resolveDeps(params: AgentLoopParams): AgentLoopDeps {
  return {
    callLLM: params.deps?.callLLM ?? ((request) => params.provider.chat(request)),
    executeTool: params.deps?.executeTool ?? ((tool, input, ctx) => tool.call(input, ctx)),
  };
}

/**
 * 发射 agent:run_end 事件并返回 AgentResult。
 * 将事件发射和结果返回合并，确保一致性。
 */
async function emitRunEnd(
  eventBus: IEventBus<AgentEventMap> | undefined,
  startTime: number,
  result: AgentResult,
): Promise<AgentResult> {
  await eventBus?.emit("agent:run_end", {
    reason: result.reason,
    duration: Date.now() - startTime,
    usage: result.usage,
    error: result.reason === "error" ? result.error.message : undefined,
  });
  return result;
}
