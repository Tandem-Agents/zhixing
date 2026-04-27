/**
 * streamLLMCall 单元测试
 *
 * 覆盖判别联合 LLMCallResult 的两条 variant：
 *   - aborted: false （正常完成 / provider error）
 *   - aborted: true  （stream 消费循环被 abort 中断 → 返 partial 数据）
 *
 * 测试用 inline async generator 模拟 callLLM stream，避免依赖真 LLM provider。
 * abort 通过 controller.abort() 在 yield 之间触发，wrapStreamWithAbortRace 保证 abort
 * 后 stream 立即退出。
 */

import { describe, expect, it } from "vitest";
import { streamLLMCall } from "../llm-call.js";
import type { AgentLoopDeps, AgentYield, LLMCallResult } from "../types.js";
import type { StreamEvent } from "../../types/llm.js";

// ─── 辅助 ───

const noopExecuteTool: AgentLoopDeps["executeTool"] = () =>
  Promise.reject(new Error("executeTool should not be called from streamLLMCall"));

async function drain(
  gen: AsyncGenerator<AgentYield, LLMCallResult>,
): Promise<{ yields: AgentYield[]; result: LLMCallResult }> {
  const yields: AgentYield[] = [];
  while (true) {
    const { value, done } = await gen.next();
    if (done) return { yields, result: value };
    yields.push(value);
  }
}

// ─── abort 路径 ───

describe("streamLLMCall · abort 路径", () => {
  it("已 aborted controller:wrapStreamWithAbortRace 立即退出 → partial 全空,返 aborted variant", async () => {
    const ctrl = new AbortController();
    ctrl.abort();

    let chunkCount = 0;
    const callLLM: AgentLoopDeps["callLLM"] = async function* () {
      yield { type: "message_start" };
      chunkCount++;
      yield { type: "text_delta", text: "should not be processed" };
      chunkCount++;
    };

    const { result, yields } = await drain(
      streamLLMCall({
        deps: { callLLM, executeTool: noopExecuteTool },
        messages: [],
        model: "test",
        toolSpecs: [],
        controller: ctrl,
      }),
    );

    expect(result.aborted).toBe(true);
    if (result.aborted) {
      expect(result.partial.text).toBe("");
      expect(result.partial.thinking).toBe("");
    }
    expect(yields.filter((y) => y.type === "assistant_message")).toHaveLength(0);
    // race 立即退出,mock 不 chunkCount++ (yield 都没机会触发)
    expect(chunkCount).toBe(0);
  });

  it("abort 在第 N chunk 后触发:partial 累积已收到的 text + thinking,不 yield assistant_message", async () => {
    const ctrl = new AbortController();

    const callLLM: AgentLoopDeps["callLLM"] = async function* () {
      yield { type: "message_start" };
      yield { type: "thinking_delta", thinking: "Let me think... " };
      yield { type: "text_delta", text: "Hello " };
      yield { type: "text_delta", text: "world" };
      // 在 yield "world" 被 streamLLMCall 处理后 (累积进 pendingText) 触发 abort,
      // wrapStreamWithAbortRace 让下次 next() 立即返 done
      ctrl.abort();
      yield { type: "text_delta", text: "should not be in partial" };
    };

    const { result, yields } = await drain(
      streamLLMCall({
        deps: { callLLM, executeTool: noopExecuteTool },
        messages: [],
        model: "test",
        toolSpecs: [],
        controller: ctrl,
      }),
    );

    expect(result.aborted).toBe(true);
    if (result.aborted) {
      // partial 累积已收到的 chunk (先处理后 check 模式保证)
      expect(result.partial.text).toBe("Hello world");
      expect(result.partial.thinking).toBe("Let me think... ");
    }

    // 不 yield assistant_message (cleanup 在 agent-loop 注入 [interrupted] 标记后再 yield)
    expect(yields.filter((y) => y.type === "assistant_message")).toHaveLength(0);
    // text_delta / thinking_delta 仍透传给消费者 (用户已看到部分内容,不能撤回)
    expect(yields.filter((y) => y.type === "text_delta")).toHaveLength(2);
    expect(yields.filter((y) => y.type === "thinking_delta")).toHaveLength(1);
  });

  it("abort 路径:pendingToolCalls 不进 partial (类型层保证 partial 仅含 text+thinking)", async () => {
    const ctrl = new AbortController();

    const callLLM: AgentLoopDeps["callLLM"] = async function* () {
      yield { type: "message_start" };
      yield { type: "text_delta", text: "I'll call a tool: " };
      yield { type: "tool_call_start", id: "tc1", name: "test_tool" };
      yield { type: "tool_call_delta", id: "tc1", argsFragment: '{"key":"val"}' };
      ctrl.abort();
      yield { type: "tool_call_end", id: "tc1" };
    };

    const { result } = await drain(
      streamLLMCall({
        deps: { callLLM, executeTool: noopExecuteTool },
        messages: [],
        model: "test",
        toolSpecs: [],
        controller: ctrl,
      }),
    );

    expect(result.aborted).toBe(true);
    if (result.aborted) {
      // partial.text 含已累积的 text,不含残缺 tool_use (协议要求每个 tool_use 配对 tool_result,
      // 残缺 tool_use 会让下一轮 LLM 报 400)
      expect(result.partial.text).toBe("I'll call a tool: ");
      // partial 类型只有 text + thinking 字段 (类型层保证,无 tool_use 字段可填)
    }
  });

  it("abort 后 usage 反映 LLM 实际处理的 tokens (如收到 message_end 则带 usage)", async () => {
    const ctrl = new AbortController();

    const callLLM: AgentLoopDeps["callLLM"] = async function* () {
      yield { type: "message_start" };
      yield { type: "text_delta", text: "Hello" };
      yield {
        type: "message_end",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 1 },
      };
      // message_end 后 abort,但 usage 已记
      ctrl.abort();
    };

    const { result } = await drain(
      streamLLMCall({
        deps: { callLLM, executeTool: noopExecuteTool },
        messages: [],
        model: "test",
        toolSpecs: [],
        controller: ctrl,
      }),
    );

    expect(result.aborted).toBe(true);
    if (result.aborted) {
      // usage 反映 LLM 实际处理的 tokens (不是 emptyUsage)
      expect(result.usage.inputTokens).toBe(10);
      expect(result.usage.outputTokens).toBe(1);
    }
  });
});

// ─── 正常路径 ───

describe("streamLLMCall · 正常路径", () => {
  it("正常完成:返 success variant + yield assistant_message", async () => {
    const ctrl = new AbortController();

    const callLLM: AgentLoopDeps["callLLM"] = async function* () {
      yield { type: "message_start" };
      yield { type: "text_delta", text: "Hello world" };
      yield {
        type: "message_end",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    };

    const { result, yields } = await drain(
      streamLLMCall({
        deps: { callLLM, executeTool: noopExecuteTool },
        messages: [],
        model: "test",
        toolSpecs: [],
        controller: ctrl,
      }),
    );

    expect(result.aborted).toBe(false);
    if (!result.aborted) {
      expect(result.message.role).toBe("assistant");
      const textBlock = result.message.content.find((b) => b.type === "text");
      expect(textBlock).toBeDefined();
      if (textBlock?.type === "text") {
        expect(textBlock.text).toBe("Hello world");
      }
      expect(result.stopReason).toBe("end_turn");
      expect(result.usage.outputTokens).toBe(5);
      expect(result.error).toBeUndefined();
    }

    expect(yields.filter((y) => y.type === "assistant_message")).toHaveLength(1);
  });

  it("provider error event:返 success variant 带 error,与 abort 严格分离", async () => {
    const ctrl = new AbortController();

    const callLLM: AgentLoopDeps["callLLM"] = async function* () {
      yield { type: "message_start" };
      yield { type: "text_delta", text: "Partial " };
      const err: StreamEvent = {
        type: "error",
        error: new Error("Provider rate limit exceeded"),
      };
      yield err;
    };

    const { result } = await drain(
      streamLLMCall({
        deps: { callLLM, executeTool: noopExecuteTool },
        messages: [],
        model: "test",
        toolSpecs: [],
        controller: ctrl,
      }),
    );

    // controller 未 abort → 走 success variant + error 字段 (与 aborted 严格分离)
    expect(result.aborted).toBe(false);
    if (!result.aborted) {
      expect(result.error).toBeDefined();
      expect(result.error?.type).toBe("provider_error");
      expect(result.error?.message).toContain("rate limit");
    }
  });

  it("SDK 抛非 abort 错误:返 success variant 带 error,不当 abort 处理", async () => {
    const ctrl = new AbortController();

    const callLLM: AgentLoopDeps["callLLM"] = async function* () {
      yield { type: "message_start" };
      throw new Error("network failure");
    };

    const { result } = await drain(
      streamLLMCall({
        deps: { callLLM, executeTool: noopExecuteTool },
        messages: [],
        model: "test",
        toolSpecs: [],
        controller: ctrl,
      }),
    );

    expect(result.aborted).toBe(false);
    if (!result.aborted) {
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain("network failure");
    }
  });

  it("provider error event 中含残缺 tool_use:yielded message + return.message 都用 assembleSafeMessage 跳过", async () => {
    // 修复回归:之前 provider error 路径 assembleMessage 含残缺 tool_use 进 newMessages,
    // next-turn LLM 因缺配对 tool_result 报 400。
    // 修复后 provider error 路径用 assembleSafeMessage,跳过 pendingToolCalls。
    const ctrl = new AbortController();

    const callLLM: AgentLoopDeps["callLLM"] = async function* () {
      yield { type: "message_start" };
      yield { type: "text_delta", text: "I'll call a tool: " };
      // 残缺 tool_use:tool_call_start 收到但 tool_call_end 没收
      yield { type: "tool_call_start", id: "tc1", name: "test_tool" };
      yield { type: "tool_call_delta", id: "tc1", argsFragment: '{"par' };
      // provider error 中断
      yield {
        type: "error",
        error: new Error("Provider stream interrupted"),
      };
    };

    const { result, yields } = await drain(
      streamLLMCall({
        deps: { callLLM, executeTool: noopExecuteTool },
        messages: [],
        model: "test",
        toolSpecs: [],
        controller: ctrl,
      }),
    );

    expect(result.aborted).toBe(false);
    if (!result.aborted) {
      expect(result.error).toBeDefined();
      // return.message 不含残缺 tool_use (跳过 pendingToolCalls)
      const toolUseBlocks = result.message.content.filter(
        (b) => b.type === "tool_use",
      );
      expect(toolUseBlocks).toHaveLength(0);
      // 但 text 保留 (用户已看到的部分输出)
      const textBlock = result.message.content.find((b) => b.type === "text");
      expect(textBlock).toBeDefined();
      if (textBlock?.type === "text") {
        expect(textBlock.text).toBe("I'll call a tool: ");
      }
    }

    // yielded assistant_message 同样不含 tool_use (trackMessages 收集进 newMessages 协议合规)
    const assistantMessages = yields.filter((y) => y.type === "assistant_message");
    expect(assistantMessages).toHaveLength(1);
    if (assistantMessages[0]?.type === "assistant_message") {
      const toolUseBlocks = assistantMessages[0].message.content.filter(
        (b) => b.type === "tool_use",
      );
      expect(toolUseBlocks).toHaveLength(0);
    }
  });

  it("catch 块 SDK 错误路径 + partial 非空:yield safe assistant_message (与 provider error event 路径一致)", async () => {
    // 修复回归:之前 catch 块 SDK 错误路径不 yield assistant_message,partial 内容
    // 不进 newMessages → 用户重启后 transcript 看不到部分 LLM 输出。
    // 修复后两条 stream 错误路径 (case "error" event + catch 块) 行为一致:
    // partial 非空时都 yield safe message,让 trackMessages 收集进 transcript。
    const ctrl = new AbortController();

    const callLLM: AgentLoopDeps["callLLM"] = async function* () {
      yield { type: "message_start" };
      yield { type: "text_delta", text: "Partial response " };
      yield { type: "tool_call_start", id: "tc1", name: "test_tool" };
      yield { type: "tool_call_delta", id: "tc1", argsFragment: '{"par' };
      // SDK 抛非 abort 异常 (network failure / 序列化错误等)
      throw new Error("network failure mid-stream");
    };

    const { result, yields } = await drain(
      streamLLMCall({
        deps: { callLLM, executeTool: noopExecuteTool },
        messages: [],
        model: "test",
        toolSpecs: [],
        controller: ctrl,
      }),
    );

    expect(result.aborted).toBe(false);
    if (!result.aborted) {
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain("network failure");
    }

    // yield 序列含 assistant_message (与 provider error event 路径一致)
    const assistantMessages = yields.filter((y) => y.type === "assistant_message");
    expect(assistantMessages).toHaveLength(1);
    if (assistantMessages[0]?.type === "assistant_message") {
      // text 保留 (用户已看到的 partial 输出进 transcript)
      const textBlock = assistantMessages[0].message.content.find(
        (b) => b.type === "text",
      );
      expect(textBlock).toBeDefined();
      if (textBlock?.type === "text") {
        expect(textBlock.text).toBe("Partial response ");
      }
      // 不含残缺 tool_use (assembleSafeMessage 跳过 pendingToolCalls 防协议违规)
      const toolUseBlocks = assistantMessages[0].message.content.filter(
        (b) => b.type === "tool_use",
      );
      expect(toolUseBlocks).toHaveLength(0);
    }
  });

  it("catch 块 SDK 错误路径 + partial 全空:不 yield (避免空 message 进 newMessages)", async () => {
    const ctrl = new AbortController();

    const callLLM: AgentLoopDeps["callLLM"] = async function* () {
      yield { type: "message_start" };
      // 立即抛错,partial 全空
      throw new Error("immediate network failure");
    };

    const { result, yields } = await drain(
      streamLLMCall({
        deps: { callLLM, executeTool: noopExecuteTool },
        messages: [],
        model: "test",
        toolSpecs: [],
        controller: ctrl,
      }),
    );

    expect(result.aborted).toBe(false);
    if (!result.aborted) {
      expect(result.error).toBeDefined();
      expect(result.message.content).toEqual([]);
    }
    // partial 全空时不 yield (与 provider error event 同空场景行为一致)
    expect(yields.filter((y) => y.type === "assistant_message")).toHaveLength(0);
  });

  it("provider error event 在 partial 全空时:不 yield assistant_message,return.message 是 empty content", async () => {
    // 边界:provider error 在 message_start 之后立刻触发,partial.text+thinking 全空。
    // assembleSafeMessage 返 null → 不 yield (避免空 message 进 newMessages),
    // return.message 是 { role: "assistant", content: [] } 兜底 (LLMCallSuccess.message 非 optional)
    const ctrl = new AbortController();

    const callLLM: AgentLoopDeps["callLLM"] = async function* () {
      yield { type: "message_start" };
      yield {
        type: "error",
        error: new Error("Immediate provider error"),
      };
    };

    const { result, yields } = await drain(
      streamLLMCall({
        deps: { callLLM, executeTool: noopExecuteTool },
        messages: [],
        model: "test",
        toolSpecs: [],
        controller: ctrl,
      }),
    );

    expect(result.aborted).toBe(false);
    if (!result.aborted) {
      expect(result.error).toBeDefined();
      expect(result.message.content).toEqual([]);
    }
    // 不 yield assistant_message (partial 全空)
    expect(yields.filter((y) => y.type === "assistant_message")).toHaveLength(0);
  });
});
