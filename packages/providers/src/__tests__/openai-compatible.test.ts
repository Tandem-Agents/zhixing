import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ChatRequest, StreamEvent } from "@zhixing/core";
import { userMessage } from "@zhixing/core";
import type { ResolvedProvider } from "../types.js";
import { DEFAULT_QUIRKS } from "../types.js";
import { createOpenAICompatibleProvider } from "../adapters/openai-compatible.js";

// vi.hoisted 保证 mockCreate 在 vi.mock factory 中可用（解决 ESM 提升时序问题）
// 构造函数 mock 必须用 function 关键字，箭头函数不能 new
const { mockCreate, MockOpenAI } = vi.hoisted(() => {
  const mockCreate = vi.fn();
  const MockOpenAI = vi.fn(function () {
    return { chat: { completions: { create: mockCreate } } };
  });
  return { mockCreate, MockOpenAI };
});

vi.mock("openai", () => ({ default: MockOpenAI }));

// 辅助：把 AsyncGenerator 收集为数组
async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

// 辅助：构建模拟的 SSE 流式 chunk
function textChunk(content: string, finishReason: string | null = null) {
  return {
    choices: [
      {
        delta: { content },
        finish_reason: finishReason,
      },
    ],
    usage: null,
  };
}

function toolCallStartChunk(id: string, name: string) {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id,
              function: { name, arguments: "" },
            },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  };
}

function toolCallDeltaChunk(argsFragment: string) {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              function: { arguments: argsFragment },
            },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: null,
  };
}

// Vendor 协议扩展:reasoning_content delta chunk(thinking 模式专属字段,
// 详见 adapter 顶部 Vendor Protocol Extensions section)
function reasoningChunk(content: string) {
  return {
    choices: [
      {
        delta: { reasoning_content: content },
        finish_reason: null,
      },
    ],
    usage: null,
  };
}

// usage 形态宽松到 Record —— 支持基础字段 + vendor 方言 cache 字段
// (prompt_tokens_details.cached_tokens / prompt_cache_hit_tokens 等)。
// 现有 { prompt_tokens, completion_tokens } 字面量调用站点仍然类型兼容。
function finishChunk(reason: string, usage?: Record<string, unknown>) {
  return {
    choices: [
      {
        delta: {},
        finish_reason: reason,
      },
    ],
    usage: usage ?? null,
  };
}

function usageOnlyChunk(usage: Record<string, unknown>) {
  return {
    choices: [],
    usage,
  };
}

// 辅助：创建 mock 的 async iterable
async function* mockStream<T>(chunks: T[]): AsyncGenerator<T> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function makeProvider(overrides?: Partial<ResolvedProvider>): ResolvedProvider {
  return {
    id: "test-provider",
    name: "Test Provider",
    baseUrl: "https://api.test.com",
    apiKey: "sk-test",
    protocol: "openai-compatible",
    defaultModel: "test-model",
    quirks: { ...DEFAULT_QUIRKS },
    declaredModels: [],
    ...overrides,
  };
}

describe("createOpenAICompatibleProvider", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    MockOpenAI.mockClear();
  });

  it("应正确创建 provider 实例（网关型默认 declaredModels=[]，不再造伪条目）", () => {
    const provider = createOpenAICompatibleProvider(makeProvider());

    expect(provider.id).toBe("test-provider");
    expect(provider.models).toEqual([]);
  });

  it("declaredModels 非空时 → models 直接复用 catalog（零 mapping）", () => {
    const declared = [
      {
        id: "Pro/MiniMaxAI/MiniMax-M2.5",
        name: "MiniMax-M2.5",
        contextWindow: 245_760,
        maxOutputTokens: 8_192,
        supportsTools: true,
      },
    ];
    const provider = createOpenAICompatibleProvider(
      makeProvider({ declaredModels: declared }),
    );

    expect(provider.models).toBe(declared);
  });

  it("应正确处理纯文本流式响应", async () => {
    mockCreate.mockResolvedValue(
      mockStream([
        textChunk("Hello"),
        textChunk(", world!"),
        finishChunk("stop", { prompt_tokens: 10, completion_tokens: 5 }),
      ]),
    );

    const provider = createOpenAICompatibleProvider(makeProvider());
    const request: ChatRequest = {
      model: "test-model",
      messages: [userMessage("Hi")],
    };

    const events = await collectEvents(provider.chat(request));

    expect(events[0]).toEqual({ type: "message_start" });

    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents).toHaveLength(2);
    expect(textEvents[0]).toEqual({ type: "text_delta", text: "Hello" });
    expect(textEvents[1]).toEqual({ type: "text_delta", text: ", world!" });

    const endEvent = events.find((e) => e.type === "message_end");
    expect(endEvent).toBeDefined();
    if (endEvent?.type === "message_end") {
      expect(endEvent.stopReason).toBe("end_turn");
      expect(endEvent.usage.inputTokens).toBe(10);
      expect(endEvent.usage.outputTokens).toBe(5);
    }
  });

  it("应正确处理工具调用流式响应", async () => {
    mockCreate.mockResolvedValue(
      mockStream([
        toolCallStartChunk("call_123", "read_file"),
        toolCallDeltaChunk('{"path":'),
        toolCallDeltaChunk('"./test.ts"}'),
        finishChunk("tool_calls"),
      ]),
    );

    const provider = createOpenAICompatibleProvider(makeProvider());
    const request: ChatRequest = {
      model: "test-model",
      messages: [userMessage("Read the test file")],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      ],
    };

    const events = await collectEvents(provider.chat(request));

    const startEvent = events.find((e) => e.type === "tool_call_start");
    expect(startEvent).toEqual({
      type: "tool_call_start",
      id: "call_123",
      name: "read_file",
    });

    const deltaEvents = events.filter((e) => e.type === "tool_call_delta");
    expect(deltaEvents).toHaveLength(2);
    expect(deltaEvents[0]).toEqual({
      type: "tool_call_delta",
      id: "call_123",
      argsFragment: '{"path":',
    });

    const endCallEvent = events.find((e) => e.type === "tool_call_end");
    expect(endCallEvent).toEqual({ type: "tool_call_end", id: "call_123" });

    const msgEnd = events.find((e) => e.type === "message_end");
    if (msgEnd?.type === "message_end") {
      expect(msgEnd.stopReason).toBe("tool_use");
    }
  });

  it("应正确处理带 stream_options.include_usage 的 usage chunk", async () => {
    mockCreate.mockResolvedValue(
      mockStream([
        textChunk("Hello"),
        finishChunk("stop"),
        usageOnlyChunk({ prompt_tokens: 42, completion_tokens: 10 }),
      ]),
    );

    const provider = createOpenAICompatibleProvider(
      makeProvider({
        quirks: { ...DEFAULT_QUIRKS, supportsStreamUsage: true },
      }),
    );

    const events = await collectEvents(
      provider.chat({ model: "test-model", messages: [userMessage("Hi")] }),
    );

    const endEvent = events.find((e) => e.type === "message_end");
    if (endEvent?.type === "message_end") {
      expect(endEvent.usage.inputTokens).toBe(42);
      expect(endEvent.usage.outputTokens).toBe(10);
    }
  });

  // ─── Wire-up 集成契约: usage 方言归一是否真接到 message_end 事件 ───
  //
  // 单元测试(openai-usage.test.ts)守"parser 算法正确",本组测试守"wire-up 正确"——
  // chunk.usage → parseOpenAICompatibleUsage(provider.quirks.usageDialect) → message_end
  // 这条端到端通路里任意一环错位(传错字段 / 传错 quirks / 漏调 parser)都会被捕获。

  it("Wire-up: OpenAI 标准方言 quirks=auto → cacheReadTokens 流到 message_end", async () => {
    // MiniMax / OpenAI / Kimi 等大多数兼容 vendor 走此路径(preset 不显式声明,默认 auto)。
    mockCreate.mockResolvedValue(
      mockStream([
        textChunk("Hi"),
        finishChunk("stop"),
        usageOnlyChunk({
          prompt_tokens: 1200,
          completion_tokens: 300,
          total_tokens: 1500,
          prompt_tokens_details: { cached_tokens: 800 },
        }),
      ]),
    );

    const provider = createOpenAICompatibleProvider(
      makeProvider({
        quirks: { ...DEFAULT_QUIRKS, supportsStreamUsage: true },
        // 不显式声明 usageDialect → 走 auto 嗅探链(默认 DEFAULT_QUIRKS.usageDialect)
      }),
    );

    const events = await collectEvents(
      provider.chat({ model: "test-model", messages: [userMessage("Hi")] }),
    );

    const endEvent = events.find((e) => e.type === "message_end");
    expect(endEvent).toBeDefined();
    if (endEvent?.type === "message_end") {
      expect(endEvent.usage.inputTokens).toBe(1200);
      expect(endEvent.usage.outputTokens).toBe(300);
      expect(endEvent.usage.cacheReadTokens).toBe(800);
      // OpenAI 兼容协议下无 cache_write 维度
      expect(endEvent.usage.cacheWriteTokens).toBeUndefined();
    }
  });

  it("Wire-up: DeepSeek 方言 quirks.usageDialect=deepseek → cacheReadTokens 流到 message_end", async () => {
    // DeepSeek preset 显式声明 usageDialect=deepseek,走最短解析路径。
    // 验证 quirks.usageDialect 字段是否真的被 wire 到 parseOpenAICompatibleUsage 调用。
    mockCreate.mockResolvedValue(
      mockStream([
        textChunk("Hi"),
        finishChunk("stop"),
        usageOnlyChunk({
          prompt_tokens: 1500,
          completion_tokens: 200,
          prompt_cache_hit_tokens: 1200,
          prompt_cache_miss_tokens: 300,
        }),
      ]),
    );

    const provider = createOpenAICompatibleProvider(
      makeProvider({
        quirks: {
          ...DEFAULT_QUIRKS,
          supportsStreamUsage: true,
          usageDialect: "deepseek",
        },
      }),
    );

    const events = await collectEvents(
      provider.chat({ model: "test-model", messages: [userMessage("Hi")] }),
    );

    const endEvent = events.find((e) => e.type === "message_end");
    expect(endEvent).toBeDefined();
    if (endEvent?.type === "message_end") {
      expect(endEvent.usage.inputTokens).toBe(1500);
      expect(endEvent.usage.outputTokens).toBe(200);
      expect(endEvent.usage.cacheReadTokens).toBe(1200);
    }
  });

  it("SDK 异常时应产出 error 事件", async () => {
    mockCreate.mockRejectedValue(new Error("API rate limit exceeded"));

    const provider = createOpenAICompatibleProvider(makeProvider());
    const events = await collectEvents(
      provider.chat({ model: "test-model", messages: [userMessage("Hi")] }),
    );

    expect(events[0]).toEqual({ type: "message_start" });
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "error") {
      expect(errorEvent.error.message).toContain("rate limit");
    }
  });

  it("应将 system prompt 作为首条 system 消息注入", async () => {
    mockCreate.mockResolvedValue(mockStream([finishChunk("stop")]));

    const provider = createOpenAICompatibleProvider(makeProvider());
    await collectEvents(
      provider.chat({
        model: "test-model",
        messages: [userMessage("Hi")],
        systemPrompt: "You are a helpful assistant",
      }),
    );

    const callArgs = mockCreate.mock.calls[0]?.[0];
    expect(callArgs.messages[0]).toEqual({
      role: "system",
      content: "You are a helpful assistant",
    });
    expect(callArgs.messages[1]).toEqual({
      role: "user",
      content: "Hi",
    });
  });

  it("应根据 quirks.maxTokensField 使用正确的参数名", async () => {
    mockCreate.mockResolvedValue(mockStream([finishChunk("stop")]));

    const provider = createOpenAICompatibleProvider(
      makeProvider({
        quirks: { ...DEFAULT_QUIRKS, maxTokensField: "max_completion_tokens" },
      }),
    );

    await collectEvents(
      provider.chat({
        model: "test-model",
        messages: [userMessage("Hi")],
        maxTokens: 2048,
      }),
    );

    const callArgs = mockCreate.mock.calls[0]?.[0];
    expect(callArgs.max_completion_tokens).toBe(2048);
    expect(callArgs.max_tokens).toBeUndefined();
  });

  it("应传递 stream_options 当 quirks.supportsStreamUsage 为 true", async () => {
    mockCreate.mockResolvedValue(mockStream([finishChunk("stop")]));

    const provider = createOpenAICompatibleProvider(
      makeProvider({
        quirks: { ...DEFAULT_QUIRKS, supportsStreamUsage: true },
      }),
    );

    await collectEvents(
      provider.chat({ model: "test-model", messages: [userMessage("Hi")] }),
    );

    const callArgs = mockCreate.mock.calls[0]?.[0];
    expect(callArgs.stream_options).toEqual({ include_usage: true });
  });

  it("应正确转换包含 tool_result 的消息序列", async () => {
    mockCreate.mockResolvedValue(mockStream([finishChunk("stop")]));

    const provider = createOpenAICompatibleProvider(makeProvider());
    await collectEvents(
      provider.chat({
        model: "test-model",
        messages: [
          userMessage("Read my file"),
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call_1",
                name: "read_file",
                input: { path: "./test.ts" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "call_1",
                content: "file contents here",
              },
            ],
          },
        ],
      }),
    );

    const callArgs = mockCreate.mock.calls[0]?.[0];
    const msgs = callArgs.messages;

    // user → assistant(tool_calls) → tool → ...
    expect(msgs[0]).toEqual({ role: "user", content: "Read my file" });
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].tool_calls).toHaveLength(1);
    expect(msgs[1].tool_calls[0].id).toBe("call_1");
    expect(msgs[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "file contents here",
    });
  });

  // ─── Vendor 协议扩展: reasoning_content 字段 ───────────────────────────
  //
  // 协议级处理(详见 openai-compatible.ts 顶部 Vendor Protocol Extensions section):
  //   - 入站: stream delta 的 reasoning_content → yield thinking_delta 事件
  //   - 出站: ThinkingBlock → 拼回 assistant.reasoning_content 字段
  //   - 缺失: ThinkingBlock 不存在时 outbound payload 完全不含此字段(向后兼容)
  //
  // 覆盖 DeepSeek thinking 模式 / Qwen-QwQ / Kimi-thinking / 智谱 GLM-Z 等
  // 沿用 reasoning_content 约定的全部 thinking 模型。

  it("入站: reasoning_content → thinking_block_start → thinking_delta* → thinking_block_end → text_delta 完整边界序列", async () => {
    mockCreate.mockResolvedValue(
      mockStream([
        reasoningChunk("思考中..."),
        reasoningChunk("得出结论"),
        textChunk("最终回答"),
        finishChunk("stop"),
      ]),
    );

    const provider = createOpenAICompatibleProvider(makeProvider());
    const events = await collectEvents(
      provider.chat({ model: "test-model", messages: [userMessage("Hi")] }),
    );

    // 边界事件: thinking_block_start / thinking_block_end 各 1 次,首次 reasoning_content
    // 触发 start,首次 content 触发 end(状态机推断,DeepSeek 协议无显式边界事件)
    expect(events.filter((e) => e.type === "thinking_block_start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "thinking_block_end")).toHaveLength(1);

    const thinkingEvents = events.filter((e) => e.type === "thinking_delta");
    expect(thinkingEvents).toHaveLength(2);
    expect(thinkingEvents[0]).toEqual({ type: "thinking_delta", thinking: "思考中..." });
    expect(thinkingEvents[1]).toEqual({ type: "thinking_delta", thinking: "得出结论" });

    // 完整时序: start → delta* → end → text_delta —— 与 tool_call_start/end 对称
    const startIdx = events.findIndex((e) => e.type === "thinking_block_start");
    const firstDeltaIdx = events.findIndex((e) => e.type === "thinking_delta");
    const endIdx = events.findIndex((e) => e.type === "thinking_block_end");
    const firstTextIdx = events.findIndex((e) => e.type === "text_delta");
    expect(startIdx).toBeLessThan(firstDeltaIdx);
    expect(firstDeltaIdx).toBeLessThan(endIdx);
    expect(endIdx).toBeLessThan(firstTextIdx);
  });

  it("入站: 纯 thinking 无 content (LLM 只 think 不回复) 时 finish_reason 兜底 emit thinking_block_end", async () => {
    // 极端场景:LLM 完整生成 reasoning_content 但没有 content 字段,finish_reason
    // 直接到达。状态机若不兜底,thinking_block_end 永不 emit,消费方 segment 悬挂。
    mockCreate.mockResolvedValue(
      mockStream([reasoningChunk("纯推理无回复"), finishChunk("stop")]),
    );

    const provider = createOpenAICompatibleProvider(makeProvider());
    const events = await collectEvents(
      provider.chat({ model: "test-model", messages: [userMessage("Hi")] }),
    );

    expect(events.filter((e) => e.type === "thinking_block_start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "thinking_block_end")).toHaveLength(1);
    // text_delta 应零(LLM 没输出 content)
    expect(events.filter((e) => e.type === "text_delta")).toHaveLength(0);
    // thinking_block_end 应在 message_end 之前
    const endIdx = events.findIndex((e) => e.type === "thinking_block_end");
    const msgEndIdx = events.findIndex((e) => e.type === "message_end");
    expect(endIdx).toBeLessThan(msgEndIdx);
  });

  it("入站: 无 reasoning_content(普通 model)零 thinking 事件,不影响 text_delta 流", async () => {
    mockCreate.mockResolvedValue(
      mockStream([textChunk("Hello"), textChunk(", world"), finishChunk("stop")]),
    );

    const provider = createOpenAICompatibleProvider(makeProvider());
    const events = await collectEvents(
      provider.chat({ model: "test-model", messages: [userMessage("Hi")] }),
    );

    expect(events.filter((e) => e.type === "thinking_block_start")).toHaveLength(0);
    expect(events.filter((e) => e.type === "thinking_block_end")).toHaveLength(0);
    expect(events.filter((e) => e.type === "thinking_delta")).toHaveLength(0);
    expect(events.filter((e) => e.type === "text_delta")).toHaveLength(2);
  });

  it("出站: ThinkingBlock 应拼回 assistant.reasoning_content 字段供 replay 回传", async () => {
    mockCreate.mockResolvedValue(mockStream([finishChunk("stop")]));

    const provider = createOpenAICompatibleProvider(makeProvider());
    await collectEvents(
      provider.chat({
        model: "test-model",
        messages: [
          userMessage("Read my file"),
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "我需要先读文件再回答" },
              {
                type: "tool_use",
                id: "call_1",
                name: "read_file",
                input: { path: "./test.ts" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "call_1",
                content: "file contents",
              },
            ],
          },
        ],
      }),
    );

    const callArgs = mockCreate.mock.calls[0]?.[0];
    const assistantMsg = callArgs.messages.find(
      (m: { role: string }) => m.role === "assistant",
    );
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.reasoning_content).toBe("我需要先读文件再回答");
    // 同 message 内 reasoning_content 与 tool_calls 共存(thinking 模式产生工具调用的场景)
    expect(assistantMsg.tool_calls).toHaveLength(1);
    expect(assistantMsg.tool_calls[0].id).toBe("call_1");
  });

  it("回归: 无 ThinkingBlock 时 outbound 不写 reasoning_content 字段(非 thinking 模型路径)", async () => {
    mockCreate.mockResolvedValue(mockStream([finishChunk("stop")]));

    const provider = createOpenAICompatibleProvider(makeProvider());
    await collectEvents(
      provider.chat({
        model: "test-model",
        messages: [
          userMessage("Read my file"),
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call_1",
                name: "read_file",
                input: { path: "./test.ts" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "call_1",
                content: "file contents",
              },
            ],
          },
        ],
      }),
    );

    const callArgs = mockCreate.mock.calls[0]?.[0];
    const assistantMsg = callArgs.messages.find(
      (m: { role: string }) => m.role === "assistant",
    );
    expect(assistantMsg).toBeDefined();
    expect("reasoning_content" in assistantMsg).toBe(false);
    // 既有 tool_calls 出站路径不受影响
    expect(assistantMsg.tool_calls).toHaveLength(1);
  });
});

describe("createOpenAICompatibleProvider · 思考控制发送侧", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("deepseek 方言 + effort 配置 → 发原生 thinking + reasoning_effort", async () => {
    mockCreate.mockResolvedValue(mockStream([finishChunk("stop")]));

    const provider = createOpenAICompatibleProvider(
      makeProvider({ quirks: { ...DEFAULT_QUIRKS, thinkingDialect: "deepseek" } }),
    );
    await collectEvents(
      provider.chat({
        model: "deepseek-v4-pro",
        messages: [userMessage("Hi")],
        thinking: { mode: "effort", effort: "max" },
      }),
    );

    const callArgs = mockCreate.mock.calls[0]?.[0];
    expect(callArgs.thinking).toEqual({ type: "enabled" });
    expect(callArgs.reasoning_effort).toBe("max");
  });

  it("未配 thinking → 请求不带任何思考参数", async () => {
    mockCreate.mockResolvedValue(mockStream([finishChunk("stop")]));

    const provider = createOpenAICompatibleProvider(
      makeProvider({ quirks: { ...DEFAULT_QUIRKS, thinkingDialect: "deepseek" } }),
    );
    await collectEvents(
      provider.chat({ model: "deepseek-v4-pro", messages: [userMessage("Hi")] }),
    );

    const callArgs = mockCreate.mock.calls[0]?.[0];
    expect(callArgs.thinking).toBeUndefined();
    expect(callArgs.reasoning_effort).toBeUndefined();
  });

  it("none 方言（默认 quirks）→ 即便配了 thinking 也不发", async () => {
    mockCreate.mockResolvedValue(mockStream([finishChunk("stop")]));

    const provider = createOpenAICompatibleProvider(makeProvider());
    await collectEvents(
      provider.chat({
        model: "test-model",
        messages: [userMessage("Hi")],
        thinking: { mode: "on" },
      }),
    );

    const callArgs = mockCreate.mock.calls[0]?.[0];
    expect(callArgs.thinking).toBeUndefined();
  });
});
