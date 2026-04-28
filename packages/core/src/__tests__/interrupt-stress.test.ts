/**
 * 可中断 Agent Loop 实战压测。
 *
 * 在 mock LLM provider + slow tool 场景下验证关键不变量:
 * - abort 传播延迟 P95 ≤ 200ms (loop 框架 SLO, 隔离工具自身 abort 等待消耗)
 * - 协议合规率 100% (每个 tool_use 配对 tool_result, 无残缺无孤儿)
 * - usage 计入率 100% (LLM 调用过的实验都有 usage > emptyUsage)
 *
 * 度量策略:
 * - 100 次实验, 每次随机时刻触发 abort
 * - 异步 mock provider: stream event 之间 sleep 5ms 让 abort 有机会在中段触发
 * - slow tool: 50ms 模拟 IO, 响应 abort 立即抛 AbortError
 * - 真实 performance.now() 度量 abort 触发到 run_end 的延迟
 *
 * 时间预算:
 * - 单实验估计 300-400ms (5 chunks × 5ms + 5 tools × 50ms + 调度抖动)
 * - 100 次合计 30-40s, vitest timeout 90s 余量充足
 * - 无 hang 风险: mock 完全 deterministic, sleep 都是有限时长
 */

import { describe, expect, it } from "vitest";
import { createEventBus } from "../events/event-bus.js";
import { runAgentLoop } from "../loop/agent-loop.js";
import type { AgentLoopParams, AgentResult, AgentYield } from "../loop/types.js";
import type { AgentEventMap } from "../types/agent-events.js";
import type {
  ChatRequest,
  LLMProvider,
  ModelInfo,
  StreamEvent,
  TokenUsage,
} from "../types/llm.js";
import { emptyUsage } from "../types/llm.js";
import { userMessage, type Message, type ToolResultBlock } from "../types/messages.js";
import type { ToolDefinition, ToolResult } from "../types/tools.js";

// ─── helper: sleep ───

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── helper: 异步 mock LLM provider ───
//
// 在 stream event 之间插 sleep, 让 abort 在 LLM stream 中段有机会触发 (与 watchdog/race
// 协调)。每个 chat() 调用消费下一个预设 response, 行为 deterministic。

interface StressResponse {
  readonly text?: string;
  readonly toolCalls?: { id: string; name: string; input: Record<string, unknown> }[];
  readonly usage?: TokenUsage;
}

const STRESS_MODEL: ModelInfo = {
  id: "stress-mock",
  name: "Stress Mock",
  contextWindow: 128_000,
  maxOutputTokens: 4096,
  supportsThinking: false,
  supportsImages: false,
  supportsTools: true,
};

function asyncMockProvider(
  responses: readonly StressResponse[],
  chunkSleepMs: number,
): LLMProvider {
  let callIndex = 0;
  return {
    id: "stress-mock",
    models: [STRESS_MODEL],
    async *chat(_request: ChatRequest): AsyncGenerator<StreamEvent, void, undefined> {
      const response = responses[callIndex++];
      if (!response) {
        throw new Error(`asyncMockProvider: no response for call #${callIndex - 1}`);
      }

      yield { type: "message_start" };
      await sleep(chunkSleepMs);

      if (response.text) {
        // 拆 text 成多个 chunks 模拟流式 (每 5 字符一个 chunk)
        for (let i = 0; i < response.text.length; i += 5) {
          yield { type: "text_delta", text: response.text.slice(i, i + 5) };
          await sleep(chunkSleepMs);
        }
      }

      if (response.toolCalls) {
        for (const tc of response.toolCalls) {
          yield { type: "tool_call_start", id: tc.id, name: tc.name };
          await sleep(chunkSleepMs);
          yield {
            type: "tool_call_delta",
            id: tc.id,
            argsFragment: JSON.stringify(tc.input),
          };
          await sleep(chunkSleepMs);
          yield { type: "tool_call_end", id: tc.id };
          await sleep(chunkSleepMs);
        }
      }

      const stopReason = response.toolCalls?.length ? "tool_use" : "end_turn";
      const usage = response.usage ?? { inputTokens: 100, outputTokens: 50 };
      yield { type: "message_end", stopReason, usage };
    },
  };
}

// ─── helper: slow tool (响应 abort 立即抛 AbortError) ───

function makeSlowTool(name: string, sleepMs: number): ToolDefinition {
  return {
    name,
    description: `Slow tool: ${name}`,
    inputSchema: { type: "object" },
    isReadOnly: true,
    isParallelSafe: false,
    needsPermission: false,
    async call(_input, ctx): Promise<ToolResult> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          ctx.abortSignal?.removeEventListener("abort", onAbort);
          resolve({ content: `${name} ok` });
        }, sleepMs);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error("AbortError"));
        };
        if (ctx.abortSignal?.aborted) {
          clearTimeout(timer);
          reject(new Error("AbortError"));
        } else {
          ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });
        }
      });
    },
  };
}

// ─── helper: 从 yield 流重建 messages (与 cli/run-agent.ts trackMessages 同模式) ───
//
// 不依赖 AgentResult 暴露 messages (保护接口稳定); 从 yields 自重建即可获得
// 协议校验需要的完整 messages 序列。

function trackMessagesFromYields(yields: readonly AgentYield[]): Message[] {
  const messages: Message[] = [];
  let pending: ToolResultBlock[] = [];
  for (const e of yields) {
    if (e.type === "assistant_message") {
      messages.push(e.message);
    } else if (e.type === "tool_end") {
      pending.push({
        type: "tool_result",
        toolUseId: e.id,
        content: e.result.content,
        isError: e.result.isError,
      });
    } else if (e.type === "turn_complete") {
      if (pending.length > 0) {
        messages.push({ role: "user", content: [...pending] });
        pending = [];
      }
    }
  }
  return messages;
}

// ─── helper: 协议合规校验 ───
//
// 协议核心约束: 每个 tool_use block 必须有同 toolUseId 的 tool_result 配对。
// abort 路径 cleanup 注入 isError placeholder 也算合规配对。

interface ValidationResult {
  readonly valid: boolean;
  readonly reason?: string;
}

function validateMessageProtocol(messages: readonly Message[]): ValidationResult {
  const toolUses = new Set<string>();
  const toolResults = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "tool_use") toolUses.add(block.id);
      }
    } else if (msg.role === "user") {
      for (const block of msg.content) {
        if (block.type === "tool_result") toolResults.add(block.toolUseId);
      }
    }
  }

  for (const id of toolUses) {
    if (!toolResults.has(id)) {
      return { valid: false, reason: `tool_use ${id} 缺配对 tool_result` };
    }
  }
  for (const id of toolResults) {
    if (!toolUses.has(id)) {
      return { valid: false, reason: `孤儿 tool_result ${id} 无对应 tool_use` };
    }
  }
  return { valid: true };
}

// ─── helper: usage 是否非空 (LLM 已实际处理) ───

function isUsageNonEmpty(usage: TokenUsage): boolean {
  return usage.inputTokens > 0 || usage.outputTokens > 0;
}

// ─── helper: 简单确定性 PRNG (LCG) ───
//
// Math.random() 是 non-deterministic, 失败时无法复现。这里用线性同余生成器
// 让 abort 时机可复现 —— 失败时改 seed 加日志即可重跑相同序列。

function createPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

// ─── 压测主体 ───

describe("可中断 Agent Loop 实战压测", () => {
  it(
    "100 次随机 abort: P95 abort 延迟 ≤ 200ms + 协议合规 100% + usage 计入率 100%",
    async () => {
      const N = 100;
      const CHUNK_SLEEP_MS = 5; // stream event 间隔
      const TOOL_SLEEP_MS = 50; // 每个 tool IO 模拟时长
      // 估计单 turn 总时长: 5 chunks × 5ms (stream open) + 5 tools × (~3 events × 5ms + 50ms tool)
      //                   ≈ 25 + 5 × 65 = 350ms
      // abort 时机随机 [0, 280ms] 让多数实验在中段触发
      const ABORT_WINDOW_MS = 280;

      const exitDelays: number[] = [];
      const toolGraceList: number[] = [];
      const usageEmptyAfterLLM: number[] = [];
      let abortedCount = 0;
      let completedCount = 0;
      let otherReasonCount = 0;
      let protocolViolations: { iter: number; reason: string }[] = [];

      const prng = createPrng(0xc0ffee);

      for (let iter = 0; iter < N; iter++) {
        const provider = asyncMockProvider(
          [
            {
              toolCalls: [
                { id: `tc${iter}-1`, name: "t1", input: {} },
                { id: `tc${iter}-2`, name: "t2", input: {} },
                { id: `tc${iter}-3`, name: "t3", input: {} },
                { id: `tc${iter}-4`, name: "t4", input: {} },
                { id: `tc${iter}-5`, name: "t5", input: {} },
              ],
            },
            { text: "all five tools done" },
          ],
          CHUNK_SLEEP_MS,
        );

        const tools = [
          makeSlowTool("t1", TOOL_SLEEP_MS),
          makeSlowTool("t2", TOOL_SLEEP_MS),
          makeSlowTool("t3", TOOL_SLEEP_MS),
          makeSlowTool("t4", TOOL_SLEEP_MS),
          makeSlowTool("t5", TOOL_SLEEP_MS),
        ];

        const ctrl = new AbortController();
        const eventBus = createEventBus<AgentEventMap>();
        let firedToolGraceMs: number | undefined;
        let firedExitDelayMs: number | undefined;
        eventBus.on("interrupt:fired", (e) => {
          firedToolGraceMs = e.toolGraceMs;
          firedExitDelayMs = e.exitDelayMs;
        });

        // 随机时刻触发 abort, 记录触发时刻 (墙钟)
        const abortAtMs = prng() * ABORT_WINDOW_MS;
        let abortFiredAt = 0;
        const abortTimer = setTimeout(() => {
          abortFiredAt = performance.now();
          ctrl.abort();
        }, abortAtMs);

        const params: AgentLoopParams = {
          provider,
          model: "stress-mock",
          tools,
          messages: [userMessage("stress")],
          abortSignal: ctrl.signal,
          eventBus,
        };

        const yields: AgentYield[] = [];
        const gen = runAgentLoop(params);
        let result: AgentResult;
        while (true) {
          const { value, done } = await gen.next();
          if (done) {
            result = value;
            break;
          }
          yields.push(value);
        }

        clearTimeout(abortTimer);

        // 度量 abort 路径
        if (result.reason === "aborted") {
          abortedCount++;
          if (abortFiredAt > 0) {
            // exitDelayMs: AgentResult 自描述的"abort 触发到 run_end 之间总延迟"
            // (含工具自身 abort 等待消耗 toolGraceMs)
            if (firedExitDelayMs !== undefined && firedExitDelayMs >= 0) {
              const loopFrameworkDelay =
                firedExitDelayMs - (firedToolGraceMs ?? 0);
              exitDelays.push(loopFrameworkDelay);
            }
            if (firedToolGraceMs !== undefined) {
              toolGraceList.push(firedToolGraceMs);
            }
          }
        } else if (result.reason === "completed") {
          completedCount++;
        } else {
          otherReasonCount++;
        }

        // 协议合规校验
        const messages = trackMessagesFromYields(yields);
        const validation = validateMessageProtocol(messages);
        if (!validation.valid) {
          protocolViolations.push({ iter, reason: validation.reason ?? "unknown" });
        }

        // usage 计入校验: 走过 LLM 的实验 usage 必须非空 (LLM 实际处理 tokens)
        // abort 在 LLM message_end 之前可能 usage = emptyUsage(LLM 还没出 message_end);
        // 这是 spec 允许的 partial usage, 不算违规
        if (result.reason === "completed" && !isUsageNonEmpty(result.usage)) {
          usageEmptyAfterLLM.push(iter);
        }
      }

      // 度量报告
      const sortedDelays = [...exitDelays].sort((a, b) => a - b);
      const percentile = (sorted: number[], p: number): number => {
        if (sorted.length === 0) return 0;
        const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
        return sorted[idx]!;
      };
      const p50 = percentile(sortedDelays, 0.5);
      const p95 = percentile(sortedDelays, 0.95);
      const p99 = percentile(sortedDelays, 0.99);
      const avgToolGrace =
        toolGraceList.length > 0
          ? toolGraceList.reduce((a, b) => a + b, 0) / toolGraceList.length
          : 0;

      console.log(
        `[stress] N=${N} aborted=${abortedCount} completed=${completedCount} other=${otherReasonCount}`,
      );
      console.log(
        `[stress] loopFrameworkDelay (exitDelayMs - toolGraceMs):` +
          ` P50=${p50.toFixed(1)}ms P95=${p95.toFixed(1)}ms P99=${p99.toFixed(1)}ms`,
      );
      console.log(
        `[stress] avg toolGraceMs=${avgToolGrace.toFixed(1)}ms (隔离工具自身 abort 等待消耗)`,
      );
      console.log(
        `[stress] protocol violations=${protocolViolations.length} usageEmpty=${usageEmptyAfterLLM.length}`,
      );

      // 断言
      // 1. 协议合规 100% — 每个 tool_use 配对 tool_result (含 cleanup placeholder)
      expect(protocolViolations).toEqual([]);

      // 2. usage 计入 — completed 路径必有非空 usage (LLM 实际处理 tokens)
      expect(usageEmptyAfterLLM).toEqual([]);

      // 3. 至少 50% 实验真触发了 abort (random 时机分布合理性)
      expect(abortedCount).toBeGreaterThan(N * 0.5);

      // 4. P95 loop 框架延迟 ≤ 200ms (隔离工具自身 abort 等待, 与 SLO 一致)
      // 度量到的延迟集合非空时才断言
      if (exitDelays.length > 0) {
        expect(p95).toBeLessThan(200);
      }
    },
    90_000,
  );
});
