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

function finishChunk(reason: string, usage?: { prompt_tokens: number; completion_tokens: number }) {
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

function usageOnlyChunk(usage: { prompt_tokens: number; completion_tokens: number }) {
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
});
