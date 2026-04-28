/**
 * Mock LLM Provider — 用于测试 Agent Loop 的确定性 Provider 实现
 *
 * 设计：预设一组响应序列，每次 chat() 调用消费下一个。
 * 支持文本回复、工具调用、thinking、错误等所有场景。
 *
 * 这不是测试专用的内部工具 —— 它是公开 API 的一部分。
 * 消费者可以用它来测试自己基于 @zhixing/core 构建的应用。
 */

import type { ChatRequest, LLMProvider, ModelInfo, StreamEvent, TokenUsage } from "../types/llm.js";

// ─── Mock 响应定义 ───

export interface MockToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface MockResponse {
  /** 文本回复内容 */
  text?: string;
  /** 思考内容（extended thinking） */
  thinking?: string;
  /** 工具调用列表（设置后 stopReason 自动为 tool_use） */
  toolCalls?: MockToolCall[];
  /** Token 用量。默认 { inputTokens: 100, outputTokens: 50 } */
  usage?: TokenUsage;
  /** 模拟流式错误（设置后其他字段被忽略） */
  error?: Error;
}

const DEFAULT_USAGE: TokenUsage = { inputTokens: 100, outputTokens: 50 };

const MOCK_MODEL: ModelInfo = {
  id: "mock-model",
  name: "Mock Model",
  contextWindow: 128_000,
  maxOutputTokens: 4096,
  supportsThinking: true,
  supportsImages: false,
  supportsTools: true,
};

// ─── MockLLMProvider ───

export class MockLLMProvider implements LLMProvider {
  readonly id = "mock";
  readonly models: readonly ModelInfo[] = [MOCK_MODEL];

  private readonly responses: MockResponse[];
  private callIndex = 0;

  /** 记录每次 chat() 调用收到的 ChatRequest，用于测试断言 */
  readonly calls: ChatRequest[] = [];

  constructor(responses: MockResponse[]) {
    this.responses = responses;
  }

  async *chat(request: ChatRequest): AsyncGenerator<StreamEvent, void, undefined> {
    this.calls.push(request);

    const response = this.responses[this.callIndex];
    if (!response) {
      throw new Error(
        `MockLLMProvider: no response configured for call #${this.callIndex}. ` +
        `Only ${this.responses.length} responses were provided.`,
      );
    }
    this.callIndex++;

    yield { type: "message_start" };

    // 错误场景
    if (response.error) {
      yield { type: "error", error: response.error };
      return;
    }

    // thinking
    if (response.thinking) {
      yield { type: "thinking_delta", thinking: response.thinking };
    }

    // 文本回复
    if (response.text) {
      yield { type: "text_delta", text: response.text };
    }

    // 工具调用
    if (response.toolCalls) {
      for (const tc of response.toolCalls) {
        yield { type: "tool_call_start", id: tc.id, name: tc.name };
        yield { type: "tool_call_delta", id: tc.id, argsFragment: JSON.stringify(tc.input) };
        yield { type: "tool_call_end", id: tc.id };
      }
    }

    const stopReason = response.toolCalls?.length ? "tool_use" as const : "end_turn" as const;
    const usage = response.usage ?? DEFAULT_USAGE;

    yield { type: "message_end", stopReason, usage };
  }

  /** 返回到目前为止的调用次数 */
  get callCount(): number {
    return this.callIndex;
  }

  /** 重置调用计数器和记录（用于复用同一个 provider 实例） */
  reset(): void {
    this.callIndex = 0;
    this.calls.length = 0;
  }
}

// ─── 便捷构造函数 ───

/** 创建一个返回简单文本回复的 MockLLMProvider */
export function mockTextProvider(text: string): MockLLMProvider {
  return new MockLLMProvider([{ text }]);
}

/** 创建一个按序列返回多个响应的 MockLLMProvider */
export function mockSequenceProvider(responses: MockResponse[]): MockLLMProvider {
  return new MockLLMProvider(responses);
}
