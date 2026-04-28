import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ChatRequest, StreamEvent } from "@zhixing/core";
import { userMessage } from "@zhixing/core";
import type { ResolvedProvider } from "../types.js";
import { DEFAULT_QUIRKS } from "../types.js";
import { createAnthropicProvider } from "../adapters/anthropic-messages.js";

// vi.hoisted 保证 mockCreate 在 vi.mock factory 中可用
// 构造函数 mock 必须用 function 关键字，箭头函数不能 new
const { mockCreate, MockAnthropic } = vi.hoisted(() => {
  const mockCreate = vi.fn();
  const MockAnthropic = vi.fn(function () {
    return { messages: { create: mockCreate } };
  });
  return { mockCreate, MockAnthropic };
});

vi.mock("@anthropic-ai/sdk", () => ({ default: MockAnthropic }));

async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

// ─── Anthropic SSE 事件构建器 ───

function messageStartEvent(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}) {
  return {
    type: "message_start" as const,
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-sonnet-4-20250514",
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  };
}

function textBlockStart(index: number) {
  return {
    type: "content_block_start" as const,
    index,
    content_block: { type: "text" as const, text: "" },
  };
}

function textDelta(index: number, text: string) {
  return {
    type: "content_block_delta" as const,
    index,
    delta: { type: "text_delta" as const, text },
  };
}

function thinkingBlockStart(index: number) {
  return {
    type: "content_block_start" as const,
    index,
    content_block: { type: "thinking" as const, thinking: "" },
  };
}

function thinkingDelta(index: number, thinking: string) {
  return {
    type: "content_block_delta" as const,
    index,
    delta: { type: "thinking_delta" as const, thinking },
  };
}

function toolUseBlockStart(index: number, id: string, name: string) {
  return {
    type: "content_block_start" as const,
    index,
    content_block: { type: "tool_use" as const, id, name, input: {} },
  };
}

function inputJsonDelta(index: number, partialJson: string) {
  return {
    type: "content_block_delta" as const,
    index,
    delta: { type: "input_json_delta" as const, partial_json: partialJson },
  };
}

function contentBlockStop(index: number) {
  return {
    type: "content_block_stop" as const,
    index,
  };
}

function messageDelta(stopReason: string, outputTokens: number) {
  return {
    type: "message_delta" as const,
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  };
}

function messageStop() {
  return { type: "message_stop" as const };
}

async function* mockStream<T>(chunks: T[]): AsyncGenerator<T> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function makeProvider(overrides?: Partial<ResolvedProvider>): ResolvedProvider {
  return {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-ant-test",
    protocol: "anthropic-messages",
    defaultModel: "claude-sonnet-4-20250514",
    quirks: {
      ...DEFAULT_QUIRKS,
      supportsThinking: true,
      supportsStreamUsage: true,
    },
    declaredModels: [],
    ...overrides,
  };
}

describe("createAnthropicProvider", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    MockAnthropic.mockClear();
  });

  it("应正确创建 provider 实例（默认 declaredModels=[]，不造伪占位）", () => {
    const provider = createAnthropicProvider(makeProvider());

    expect(provider.id).toBe("anthropic");
    expect(provider.models).toEqual([]);
  });

  it("显式传入 declaredModels 时 → models 直接复用 catalog（零 mapping）", () => {
    const declared = [
      {
        id: "claude-test",
        name: "Claude Test",
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        supportsThinking: true,
        supportsTools: true,
        supportsImages: true,
      },
    ];
    const provider = createAnthropicProvider(
      makeProvider({ declaredModels: declared }),
    );
    expect(provider.models).toBe(declared);
  });

  // ─── 纯文本响应 ───

  it("应正确处理纯文本流式响应", async () => {
    mockCreate.mockResolvedValue(
      mockStream([
        messageStartEvent({ input_tokens: 20, output_tokens: 1 }),
        textBlockStart(0),
        textDelta(0, "你好"),
        textDelta(0, "世界"),
        contentBlockStop(0),
        messageDelta("end_turn", 8),
        messageStop(),
      ]),
    );

    const provider = createAnthropicProvider(makeProvider());
    const events = await collectEvents(
      provider.chat({ model: "claude-sonnet-4-20250514", messages: [userMessage("Hi")] }),
    );

    expect(events[0]).toEqual({ type: "message_start" });

    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents).toHaveLength(2);
    expect(textEvents[0]).toEqual({ type: "text_delta", text: "你好" });
    expect(textEvents[1]).toEqual({ type: "text_delta", text: "世界" });

    const endEvent = events.find((e) => e.type === "message_end");
    expect(endEvent).toBeDefined();
    if (endEvent?.type === "message_end") {
      expect(endEvent.stopReason).toBe("end_turn");
      expect(endEvent.usage.inputTokens).toBe(20);
      expect(endEvent.usage.outputTokens).toBe(8);
    }
  });

  // ─── 工具调用 ───

  it("应正确处理工具调用流式响应", async () => {
    mockCreate.mockResolvedValue(
      mockStream([
        messageStartEvent({ input_tokens: 50, output_tokens: 1 }),
        toolUseBlockStart(0, "toolu_01", "read_file"),
        inputJsonDelta(0, '{"pa'),
        inputJsonDelta(0, 'th":"./'),
        inputJsonDelta(0, 'test.ts"}'),
        contentBlockStop(0),
        messageDelta("tool_use", 25),
        messageStop(),
      ]),
    );

    const provider = createAnthropicProvider(makeProvider());
    const request: ChatRequest = {
      model: "claude-sonnet-4-20250514",
      messages: [userMessage("Read test.ts")],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    };

    const events = await collectEvents(provider.chat(request));

    const startEvent = events.find((e) => e.type === "tool_call_start");
    expect(startEvent).toEqual({
      type: "tool_call_start",
      id: "toolu_01",
      name: "read_file",
    });

    const deltaEvents = events.filter((e) => e.type === "tool_call_delta");
    expect(deltaEvents).toHaveLength(3);
    expect(deltaEvents[0]).toEqual({
      type: "tool_call_delta",
      id: "toolu_01",
      argsFragment: '{"pa',
    });

    const endCallEvent = events.find((e) => e.type === "tool_call_end");
    expect(endCallEvent).toEqual({ type: "tool_call_end", id: "toolu_01" });

    const msgEnd = events.find((e) => e.type === "message_end");
    if (msgEnd?.type === "message_end") {
      expect(msgEnd.stopReason).toBe("tool_use");
    }
  });

  // ─── Thinking ───

  it("应正确处理 thinking 流式事件", async () => {
    mockCreate.mockResolvedValue(
      mockStream([
        messageStartEvent({ input_tokens: 30, output_tokens: 1 }),
        thinkingBlockStart(0),
        thinkingDelta(0, "让我思考一下"),
        thinkingDelta(0, "这个问题..."),
        contentBlockStop(0),
        textBlockStart(1),
        textDelta(1, "答案是42"),
        contentBlockStop(1),
        messageDelta("end_turn", 20),
        messageStop(),
      ]),
    );

    const provider = createAnthropicProvider(makeProvider());
    const events = await collectEvents(
      provider.chat({ model: "claude-sonnet-4-20250514", messages: [userMessage("思考")] }),
    );

    const thinkingEvents = events.filter((e) => e.type === "thinking_delta");
    expect(thinkingEvents).toHaveLength(2);
    expect(thinkingEvents[0]).toEqual({ type: "thinking_delta", thinking: "让我思考一下" });
    expect(thinkingEvents[1]).toEqual({ type: "thinking_delta", thinking: "这个问题..." });

    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]).toEqual({ type: "text_delta", text: "答案是42" });
  });

  // ─── Token Usage & Cache ───

  it("应正确映射 token 用量（含缓存字段）", async () => {
    mockCreate.mockResolvedValue(
      mockStream([
        messageStartEvent({
          input_tokens: 100,
          output_tokens: 1,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 20,
        }),
        textBlockStart(0),
        textDelta(0, "ok"),
        contentBlockStop(0),
        messageDelta("end_turn", 5),
        messageStop(),
      ]),
    );

    const provider = createAnthropicProvider(makeProvider());
    const events = await collectEvents(
      provider.chat({ model: "claude-sonnet-4-20250514", messages: [userMessage("Hi")] }),
    );

    const endEvent = events.find((e) => e.type === "message_end");
    if (endEvent?.type === "message_end") {
      expect(endEvent.usage.inputTokens).toBe(100);
      expect(endEvent.usage.outputTokens).toBe(5);
      expect(endEvent.usage.cacheReadTokens).toBe(80);
      expect(endEvent.usage.cacheWriteTokens).toBe(20);
    }
  });

  // ─── System Prompt & Cache Control ───

  it("应将 system prompt 作为 cache_control block 传递", async () => {
    mockCreate.mockResolvedValue(
      mockStream([
        messageStartEvent({ input_tokens: 10, output_tokens: 1 }),
        textBlockStart(0),
        textDelta(0, "ok"),
        contentBlockStop(0),
        messageDelta("end_turn", 2),
        messageStop(),
      ]),
    );

    const provider = createAnthropicProvider(makeProvider());
    await collectEvents(
      provider.chat({
        model: "claude-sonnet-4-20250514",
        messages: [userMessage("Hi")],
        systemPrompt: "You are a helpful assistant",
      }),
    );

    const callArgs = mockCreate.mock.calls[0]?.[0];
    expect(callArgs.system).toEqual([
      {
        type: "text",
        text: "You are a helpful assistant",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("应在最后一条 user 消息的最后一个 content block 上加 cache_control", async () => {
    mockCreate.mockResolvedValue(
      mockStream([
        messageStartEvent({ input_tokens: 10, output_tokens: 1 }),
        textBlockStart(0),
        textDelta(0, "ok"),
        contentBlockStop(0),
        messageDelta("end_turn", 2),
        messageStop(),
      ]),
    );

    const provider = createAnthropicProvider(makeProvider());
    await collectEvents(
      provider.chat({
        model: "claude-sonnet-4-20250514",
        messages: [
          userMessage("First message"),
          { role: "assistant", content: [{ type: "text", text: "Response" }] },
          userMessage("Second message"),
        ],
      }),
    );

    const callArgs = mockCreate.mock.calls[0]?.[0];
    const messages = callArgs.messages;

    // 第一条 user 消息不应有 cache_control
    expect(messages[0].content[0].cache_control).toBeUndefined();

    // 最后一条 user 消息应有 cache_control
    expect(messages[2].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  // ─── 消息格式转换 ───

  it("应正确转换包含 tool_result 的消息序列", async () => {
    mockCreate.mockResolvedValue(
      mockStream([
        messageStartEvent({ input_tokens: 10, output_tokens: 1 }),
        textBlockStart(0),
        textDelta(0, "ok"),
        contentBlockStop(0),
        messageDelta("end_turn", 2),
        messageStop(),
      ]),
    );

    const provider = createAnthropicProvider(makeProvider());
    await collectEvents(
      provider.chat({
        model: "claude-sonnet-4-20250514",
        messages: [
          userMessage("Read my file"),
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_01",
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
                toolUseId: "toolu_01",
                content: "file contents here",
              },
            ],
          },
        ],
      }),
    );

    const callArgs = mockCreate.mock.calls[0]?.[0];
    const msgs = callArgs.messages;

    expect(msgs[0].content[0]).toEqual({ type: "text", text: "Read my file" });

    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content[0]).toEqual({
      type: "tool_use",
      id: "toolu_01",
      name: "read_file",
      input: { path: "./test.ts" },
    });

    // tool_result 保留在 user 消息中（Anthropic 原生格式），且作为最后一条 user 消息自动带 cache_control
    expect(msgs[2].role).toBe("user");
    expect(msgs[2].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_01",
      content: "file contents here",
      is_error: false,
      cache_control: { type: "ephemeral" },
    });
  });

  // ─── 工具格式 ───

  it("应正确转换工具声明格式", async () => {
    mockCreate.mockResolvedValue(
      mockStream([
        messageStartEvent({ input_tokens: 10, output_tokens: 1 }),
        textBlockStart(0),
        textDelta(0, "ok"),
        contentBlockStop(0),
        messageDelta("end_turn", 2),
        messageStop(),
      ]),
    );

    const provider = createAnthropicProvider(makeProvider());
    await collectEvents(
      provider.chat({
        model: "claude-sonnet-4-20250514",
        messages: [userMessage("Hi")],
        tools: [
          {
            name: "bash",
            description: "Run a shell command",
            inputSchema: {
              type: "object",
              properties: {
                command: { type: "string", description: "The command" },
              },
              required: ["command"],
            },
          },
        ],
      }),
    );

    const callArgs = mockCreate.mock.calls[0]?.[0];
    expect(callArgs.tools).toEqual([
      {
        name: "bash",
        description: "Run a shell command",
        input_schema: {
          type: "object",
          properties: {
            command: { type: "string", description: "The command" },
          },
          required: ["command"],
        },
      },
    ]);
  });

  // ─── 错误处理 ───

  it("SDK 异常时应产出 error 事件", async () => {
    mockCreate.mockRejectedValue(new Error("API rate limit exceeded"));

    const provider = createAnthropicProvider(makeProvider());
    const events = await collectEvents(
      provider.chat({ model: "claude-sonnet-4-20250514", messages: [userMessage("Hi")] }),
    );

    expect(events[0]).toEqual({ type: "message_start" });
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "error") {
      expect(errorEvent.error.message).toContain("rate limit");
    }
  });

  // ─── 可选参数 ───

  it("应正确传递 temperature 和 stop_sequences", async () => {
    mockCreate.mockResolvedValue(
      mockStream([
        messageStartEvent({ input_tokens: 10, output_tokens: 1 }),
        textBlockStart(0),
        textDelta(0, "ok"),
        contentBlockStop(0),
        messageDelta("end_turn", 2),
        messageStop(),
      ]),
    );

    const provider = createAnthropicProvider(makeProvider());
    await collectEvents(
      provider.chat({
        model: "claude-sonnet-4-20250514",
        messages: [userMessage("Hi")],
        temperature: 0.5,
        stopSequences: ["STOP"],
        maxTokens: 4096,
      }),
    );

    const callArgs = mockCreate.mock.calls[0]?.[0];
    expect(callArgs.temperature).toBe(0.5);
    expect(callArgs.stop_sequences).toEqual(["STOP"]);
    expect(callArgs.max_tokens).toBe(4096);
  });

  // ─── 多工具调用 + 文本混合 ───

  it("应正确处理文本和工具调用混合的响应", async () => {
    mockCreate.mockResolvedValue(
      mockStream([
        messageStartEvent({ input_tokens: 50, output_tokens: 1 }),
        textBlockStart(0),
        textDelta(0, "Let me read that file."),
        contentBlockStop(0),
        toolUseBlockStart(1, "toolu_01", "read_file"),
        inputJsonDelta(1, '{"path":"./a.ts"}'),
        contentBlockStop(1),
        toolUseBlockStart(2, "toolu_02", "read_file"),
        inputJsonDelta(2, '{"path":"./b.ts"}'),
        contentBlockStop(2),
        messageDelta("tool_use", 30),
        messageStop(),
      ]),
    );

    const provider = createAnthropicProvider(makeProvider());
    const events = await collectEvents(
      provider.chat({ model: "claude-sonnet-4-20250514", messages: [userMessage("Read")] }),
    );

    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents).toHaveLength(1);

    const toolStarts = events.filter((e) => e.type === "tool_call_start");
    expect(toolStarts).toHaveLength(2);
    expect(toolStarts[0]).toEqual({ type: "tool_call_start", id: "toolu_01", name: "read_file" });
    expect(toolStarts[1]).toEqual({ type: "tool_call_start", id: "toolu_02", name: "read_file" });

    const toolEnds = events.filter((e) => e.type === "tool_call_end");
    expect(toolEnds).toHaveLength(2);
  });

  // ─── Stop Reason 映射 ───

  it("应正确映射 max_tokens 停止原因", async () => {
    mockCreate.mockResolvedValue(
      mockStream([
        messageStartEvent({ input_tokens: 10, output_tokens: 1 }),
        textBlockStart(0),
        textDelta(0, "truncated"),
        contentBlockStop(0),
        messageDelta("max_tokens", 4096),
        messageStop(),
      ]),
    );

    const provider = createAnthropicProvider(makeProvider());
    const events = await collectEvents(
      provider.chat({ model: "claude-sonnet-4-20250514", messages: [userMessage("Hi")] }),
    );

    const endEvent = events.find((e) => e.type === "message_end");
    if (endEvent?.type === "message_end") {
      expect(endEvent.stopReason).toBe("max_tokens");
    }
  });
});
