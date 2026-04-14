import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../../events/event-bus.js";
import type { AgentEventMap } from "../../types/agent-events.js";
import type { TokenUsage } from "../../types/llm.js";
import type { ToolDefinition } from "../../types/tools.js";
import { userMessage } from "../../types/messages.js";
import { drainAgentLoop, runAgentLoop } from "../agent-loop.js";
import { MockLLMProvider, mockTextProvider } from "../mock-provider.js";
import type { AgentLoopParams, AgentYield } from "../types.js";

// ─── 测试辅助 ───

function makeTool(name: string, handler?: (input: Record<string, unknown>) => Promise<{ content: string; isError?: boolean }>): ToolDefinition {
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: { type: "object" as const },
    isReadOnly: true,
    isParallelSafe: true,
    needsPermission: false,
    call: handler ?? (async () => ({ content: `${name} result` })),
  };
}

function baseParams(provider: MockLLMProvider, overrides?: Partial<AgentLoopParams>): AgentLoopParams {
  return {
    provider,
    model: "mock-model",
    messages: [userMessage("Hello")],
    ...overrides,
  };
}

function filterYields(yields: AgentYield[], type: AgentYield["type"]): AgentYield[] {
  return yields.filter((y) => y.type === type);
}

// ─── 测试 ───

describe("Agent Loop", () => {
  // ──────────────────────────────────────
  // 核心流程
  // ──────────────────────────────────────

  describe("核心流程", () => {
    it("无工具场景：LLM 纯文本回复 → completed", async () => {
      const provider = mockTextProvider("你好，世界！");
      const { yields, result } = await drainAgentLoop(baseParams(provider));

      expect(result.reason).toBe("completed");
      expect(result.reason === "completed" && result.message.role).toBe("assistant");

      const textDeltas = filterYields(yields, "text_delta");
      expect(textDeltas).toHaveLength(1);
      expect(textDeltas[0].type === "text_delta" && textDeltas[0].text).toBe("你好，世界！");

      const assistantMsgs = filterYields(yields, "assistant_message");
      expect(assistantMsgs).toHaveLength(1);

      // 不应有 turn_complete（没有工具调用就不算一个"轮次"）
      expect(filterYields(yields, "turn_complete")).toHaveLength(0);
    });

    it("单轮工具调用：LLM → 工具 → LLM → completed", async () => {
      const provider = new MockLLMProvider([
        {
          toolCalls: [{ id: "tc1", name: "read_file", input: { path: "/a.txt" } }],
        },
        { text: "文件内容是 hello" },
      ]);

      const readFile = makeTool("read_file", async (input) => ({
        content: `Content of ${input.path}`,
      }));

      const { yields, result } = await drainAgentLoop(
        baseParams(provider, { tools: [readFile] }),
      );

      expect(result.reason).toBe("completed");

      // 验证工具事件序列
      const toolStarts = filterYields(yields, "tool_start");
      expect(toolStarts).toHaveLength(1);
      expect(toolStarts[0].type === "tool_start" && toolStarts[0].name).toBe("read_file");

      const toolEnds = filterYields(yields, "tool_end");
      expect(toolEnds).toHaveLength(1);
      expect(toolEnds[0].type === "tool_end" && toolEnds[0].result.content).toBe("Content of /a.txt");

      // 验证 turn_complete
      const turns = filterYields(yields, "turn_complete");
      expect(turns).toHaveLength(1);
      expect(turns[0].type === "turn_complete" && turns[0].turnCount).toBe(1);

      // LLM 被调用了两次
      expect(provider.callCount).toBe(2);
    });

    it("多轮工具调用：3 轮工具交互后完成", async () => {
      const provider = new MockLLMProvider([
        { toolCalls: [{ id: "tc1", name: "search", input: { q: "foo" } }] },
        { toolCalls: [{ id: "tc2", name: "read", input: { id: "1" } }] },
        { toolCalls: [{ id: "tc3", name: "write", input: { id: "1", data: "bar" } }] },
        { text: "操作完成" },
      ]);

      const tools = [makeTool("search"), makeTool("read"), makeTool("write")];
      const { yields, result } = await drainAgentLoop(
        baseParams(provider, { tools }),
      );

      expect(result.reason).toBe("completed");

      // 3 轮 turn_complete + 3 对 tool_start/tool_end
      expect(filterYields(yields, "turn_complete")).toHaveLength(3);
      expect(filterYields(yields, "tool_start")).toHaveLength(3);
      expect(filterYields(yields, "tool_end")).toHaveLength(3);
      expect(provider.callCount).toBe(4);
    });

    it("单次响应包含多个工具调用：并发返回结果", async () => {
      const provider = new MockLLMProvider([
        {
          toolCalls: [
            { id: "tc1", name: "tool_a", input: { x: 1 } },
            { id: "tc2", name: "tool_b", input: { y: 2 } },
            { id: "tc3", name: "tool_c", input: { z: 3 } },
          ],
        },
        { text: "Done" },
      ]);

      const tools = [makeTool("tool_a"), makeTool("tool_b"), makeTool("tool_c")];
      const { yields, result } = await drainAgentLoop(
        baseParams(provider, { tools }),
      );

      expect(result.reason).toBe("completed");
      expect(filterYields(yields, "tool_start")).toHaveLength(3);
      expect(filterYields(yields, "tool_end")).toHaveLength(3);

      // 只有一轮 turn_complete（一次 LLM 响应中的多个工具调用算一轮）
      expect(filterYields(yields, "turn_complete")).toHaveLength(1);
    });
  });

  // ──────────────────────────────────────
  // 终止条件
  // ──────────────────────────────────────

  describe("终止条件", () => {
    it("max_turns：超过限制时终止", async () => {
      const provider = new MockLLMProvider([
        { toolCalls: [{ id: "tc1", name: "t", input: {} }] },
        { toolCalls: [{ id: "tc2", name: "t", input: {} }] },
        { toolCalls: [{ id: "tc3", name: "t", input: {} }] },
        { text: "should not reach" },
      ]);

      const { result } = await drainAgentLoop(
        baseParams(provider, {
          tools: [makeTool("t")],
          maxTurns: 2,
        }),
      );

      expect(result.reason).toBe("max_turns");
      // 只调用了 2 次 LLM（第 2 轮工具执行完后 turnCount=2，下一轮 guard 拦截）
      expect(provider.callCount).toBe(2);
    });

    it("abort：AbortSignal 触发时终止", async () => {
      const controller = new AbortController();

      const provider = new MockLLMProvider([
        {
          toolCalls: [{ id: "tc1", name: "slow", input: {} }],
        },
        { text: "should not reach" },
      ]);

      // 工具执行时触发 abort
      const slowTool = makeTool("slow", async () => {
        controller.abort();
        return { content: "done" };
      });

      const { result } = await drainAgentLoop(
        baseParams(provider, {
          tools: [slowTool],
          abortSignal: controller.signal,
        }),
      );

      expect(result.reason).toBe("aborted");
    });

    it("abort：循环开始前已中止", async () => {
      const controller = new AbortController();
      controller.abort();

      const provider = mockTextProvider("should not reach");
      const { result } = await drainAgentLoop(
        baseParams(provider, { abortSignal: controller.signal }),
      );

      expect(result.reason).toBe("aborted");
      expect(provider.callCount).toBe(0);
    });
  });

  // ──────────────────────────────────────
  // 错误处理
  // ──────────────────────────────────────

  describe("错误处理", () => {
    it("LLM Provider 抛出异常 → error 终止", async () => {
      const provider = new MockLLMProvider([]);
      // callCount = 0，没有预设响应，会抛 Error

      const { result } = await drainAgentLoop(baseParams(provider));

      expect(result.reason).toBe("error");
      if (result.reason === "error") {
        expect(result.error.message).toContain("no response configured");
      }
    });

    it("LLM 流式错误事件 → error 终止", async () => {
      const provider = new MockLLMProvider([
        { error: new Error("rate limit exceeded") },
      ]);

      const { result } = await drainAgentLoop(baseParams(provider));

      expect(result.reason).toBe("error");
      if (result.reason === "error") {
        expect(result.error.message).toBe("rate limit exceeded");
        expect(result.error.type).toBe("provider_error");
        expect(result.error.recoverable).toBe(true);
      }
    });

    it("工具执行失败 → 错误作为 tool_result 返回给 LLM，不终止循环", async () => {
      const provider = new MockLLMProvider([
        { toolCalls: [{ id: "tc1", name: "flaky", input: {} }] },
        { text: "I see the tool failed" },
      ]);

      const flakyTool = makeTool("flaky", async () => {
        throw new Error("disk full");
      });

      const { yields, result } = await drainAgentLoop(
        baseParams(provider, { tools: [flakyTool] }),
      );

      // 循环未终止，正常完成
      expect(result.reason).toBe("completed");

      // 工具返回了错误
      const toolEnds = filterYields(yields, "tool_end");
      expect(toolEnds).toHaveLength(1);
      if (toolEnds[0].type === "tool_end") {
        expect(toolEnds[0].result.isError).toBe(true);
        expect(toolEnds[0].result.content).toContain("disk full");
      }

      // LLM 第二次调用收到了错误的 tool_result
      expect(provider.callCount).toBe(2);
      const secondCall = provider.calls[1];
      const lastMsg = secondCall.messages[secondCall.messages.length - 1];
      const toolResult = lastMsg.content[0];
      expect(toolResult.type).toBe("tool_result");
      if (toolResult.type === "tool_result") {
        expect(toolResult.isError).toBe(true);
      }
    });

    it("user-facing 错误 → tool_result 原样使用 error.message，不加前缀", async () => {
      // 模拟场景：用户拒绝了 LLM 请求的工具调用，并留下反馈。
      // executeTool 抛 userFacing error，message 已经是 model-friendly 文本。
      // tool-executor 应识别 userFacing=true 并把 message 原样作为
      // tool_result.content，不加 "Tool execution failed: " 前缀。
      const provider = new MockLLMProvider([
        { toolCalls: [{ id: "tc1", name: "bash", input: { command: "rm -rf /" } }] },
        { text: "Understood, I'll use rm -i instead" },
      ]);

      class UserDeclinedError extends Error {
        readonly userFacing = true as const;
        constructor(message: string) {
          super(message);
          this.name = "UserDeclinedError";
        }
      }

      const bashTool = makeTool("bash");

      const { yields, result } = await drainAgentLoop(
        baseParams(provider, {
          tools: [bashTool],
          deps: {
            executeTool: async () => {
              throw new UserDeclinedError(
                "用户拒绝了这次工具调用。用户的反馈：不要用 rm -rf，改用 rm -i。请根据该反馈调整方案。",
              );
            },
          },
        }),
      );

      expect(result.reason).toBe("completed");

      // 查看 tool_end 的 content——应该是 user-facing 原文，无前缀
      const toolEnds = filterYields(yields, "tool_end");
      expect(toolEnds).toHaveLength(1);
      if (toolEnds[0].type === "tool_end") {
        expect(toolEnds[0].result.isError).toBe(true);
        const content = toolEnds[0].result.content;
        expect(content).not.toContain("Tool execution failed");
        expect(content).toContain("用户拒绝了这次工具调用");
        expect(content).toContain("不要用 rm -rf，改用 rm -i");
      }

      // LLM 第二次调用应该看到原始反馈（用于自我纠错）
      expect(provider.callCount).toBe(2);
      const secondCall = provider.calls[1];
      const lastMsg = secondCall.messages[secondCall.messages.length - 1];
      const toolResult = lastMsg.content[0];
      expect(toolResult.type).toBe("tool_result");
      if (toolResult.type === "tool_result") {
        expect(toolResult.content).toContain("不要用 rm -rf，改用 rm -i");
        expect(toolResult.content).not.toContain("Tool execution failed");
      }
    });

    it("工具未找到 → 错误作为 tool_result 返回给 LLM", async () => {
      const provider = new MockLLMProvider([
        { toolCalls: [{ id: "tc1", name: "nonexistent", input: {} }] },
        { text: "OK" },
      ]);

      const { yields, result } = await drainAgentLoop(
        baseParams(provider, { tools: [] }),
      );

      expect(result.reason).toBe("completed");

      const toolEnds = filterYields(yields, "tool_end");
      expect(toolEnds).toHaveLength(1);
      if (toolEnds[0].type === "tool_end") {
        expect(toolEnds[0].result.isError).toBe(true);
        expect(toolEnds[0].result.content).toContain("not found");
      }
    });

    it("工具返回 isError=true → 作为错误 tool_result 返回，不终止循环", async () => {
      const provider = new MockLLMProvider([
        { toolCalls: [{ id: "tc1", name: "validator", input: {} }] },
        { text: "Validation failed, let me try differently" },
      ]);

      const validator = makeTool("validator", async () => ({
        content: "Invalid input: field 'name' is required",
        isError: true,
      }));

      const { result } = await drainAgentLoop(
        baseParams(provider, { tools: [validator] }),
      );

      expect(result.reason).toBe("completed");
      expect(provider.callCount).toBe(2);
    });
  });

  // ──────────────────────────────────────
  // 流式事件与 yield 语义
  // ──────────────────────────────────────

  describe("流式事件", () => {
    it("消费者通过手动迭代接收完整事件序列", async () => {
      const provider = new MockLLMProvider([
        { toolCalls: [{ id: "tc1", name: "echo", input: { msg: "hi" } }] },
        { text: "Echo said hi" },
      ]);

      const gen = runAgentLoop(
        baseParams(provider, { tools: [makeTool("echo")] }),
      );

      const events: AgentYield[] = [];
      let result;

      while (true) {
        const { value, done } = await gen.next();
        if (done) {
          result = value;
          break;
        }
        events.push(value);
      }

      expect(result!.reason).toBe("completed");

      // 验证事件顺序（第一轮）
      const types = events.map((e) => e.type);
      const firstAssistantIdx = types.indexOf("assistant_message");
      const toolStartIdx = types.indexOf("tool_start");
      const toolEndIdx = types.indexOf("tool_end");
      const turnCompleteIdx = types.indexOf("turn_complete");

      // assistant_message 在 tool_start 之前（LLM 响应先组装完才执行工具）
      expect(firstAssistantIdx).toBeLessThan(toolStartIdx);
      expect(toolStartIdx).toBeLessThan(toolEndIdx);
      expect(toolEndIdx).toBeLessThan(turnCompleteIdx);
    });

    it("thinking_delta 正确传递", async () => {
      const provider = new MockLLMProvider([
        { thinking: "Let me think about this...", text: "The answer is 42" },
      ]);

      const { yields } = await drainAgentLoop(baseParams(provider));

      const thinkingDeltas = filterYields(yields, "thinking_delta");
      expect(thinkingDeltas).toHaveLength(1);
      expect(
        thinkingDeltas[0].type === "thinking_delta" &&
        thinkingDeltas[0].thinking,
      ).toBe("Let me think about this...");
    });

    it("text 和 thinking 同时存在的消息正确组装", async () => {
      const provider = new MockLLMProvider([
        { thinking: "hmm", text: "answer" },
      ]);

      const { yields } = await drainAgentLoop(baseParams(provider));

      const assistantMsgs = filterYields(yields, "assistant_message");
      expect(assistantMsgs).toHaveLength(1);
      if (assistantMsgs[0].type === "assistant_message") {
        const msg = assistantMsgs[0].message;
        expect(msg.content).toHaveLength(2);
        expect(msg.content[0].type).toBe("thinking");
        expect(msg.content[1].type).toBe("text");
      }
    });
  });

  // ──────────────────────────────────────
  // EventBus 集成
  // ──────────────────────────────────────

  describe("EventBus 集成", () => {
    it("完整生命周期事件", async () => {
      const eventBus = new EventBus<AgentEventMap>();
      const events: Array<{ name: string; data: unknown }> = [];

      eventBus.on("agent:run_start", (data) => { events.push({ name: "agent:run_start", data }); });
      eventBus.on("agent:run_end", (data) => { events.push({ name: "agent:run_end", data }); });
      eventBus.on("llm:request_start", (data) => { events.push({ name: "llm:request_start", data }); });
      eventBus.on("llm:request_end", (data) => { events.push({ name: "llm:request_end", data }); });

      const provider = mockTextProvider("Hello");
      await drainAgentLoop(baseParams(provider, { eventBus }));

      const eventNames = events.map((e) => e.name);
      expect(eventNames).toEqual([
        "agent:run_start",
        "llm:request_start",
        "llm:request_end",
        "agent:run_end",
      ]);

      // run_end 包含正确的 reason
      const runEnd = events.find((e) => e.name === "agent:run_end")!.data as { reason: string };
      expect(runEnd.reason).toBe("completed");
    });

    it("工具执行事件", async () => {
      const eventBus = new EventBus<AgentEventMap>();
      const toolEvents: Array<{ name: string; data: unknown }> = [];

      eventBus.on("tool:call_start", (data) => { toolEvents.push({ name: "tool:call_start", data }); });
      eventBus.on("tool:call_end", (data) => { toolEvents.push({ name: "tool:call_end", data }); });

      const provider = new MockLLMProvider([
        { toolCalls: [{ id: "tc1", name: "greet", input: { name: "World" } }] },
        { text: "Done" },
      ]);

      await drainAgentLoop(
        baseParams(provider, {
          tools: [makeTool("greet")],
          eventBus,
        }),
      );

      expect(toolEvents).toHaveLength(2);
      expect(toolEvents[0].name).toBe("tool:call_start");
      expect(toolEvents[1].name).toBe("tool:call_end");

      const endData = toolEvents[1].data as { success: boolean; resultSize: number };
      expect(endData.success).toBe(true);
      expect(endData.resultSize).toBeGreaterThan(0);
    });

    it("LLM 流式事件透传到 EventBus", async () => {
      const eventBus = new EventBus<AgentEventMap>();
      const streamEvents: unknown[] = [];

      eventBus.on("llm:stream_event", (data) => { streamEvents.push(data); });

      const provider = mockTextProvider("Hi");
      await drainAgentLoop(baseParams(provider, { eventBus }));

      const types = streamEvents.map((e: any) => e.type);
      expect(types).toContain("message_start");
      expect(types).toContain("text_delta");
      expect(types).toContain("message_end");
    });

    it("错误终止时 run_end 事件包含错误信息", async () => {
      const eventBus = new EventBus<AgentEventMap>();
      let runEndData: any;

      eventBus.on("agent:run_end", (data) => { runEndData = data; });

      const provider = new MockLLMProvider([
        { error: new Error("API down") },
      ]);

      await drainAgentLoop(baseParams(provider, { eventBus }));

      expect(runEndData.reason).toBe("error");
      expect(runEndData.error).toBe("API down");
    });
  });

  // ──────────────────────────────────────
  // Token 用量追踪
  // ──────────────────────────────────────

  describe("Token 用量追踪", () => {
    it("累积多轮调用的 usage", async () => {
      const usage1: TokenUsage = { inputTokens: 100, outputTokens: 50 };
      const usage2: TokenUsage = { inputTokens: 200, outputTokens: 80 };
      const usage3: TokenUsage = { inputTokens: 150, outputTokens: 30 };

      const provider = new MockLLMProvider([
        { toolCalls: [{ id: "tc1", name: "t", input: {} }], usage: usage1 },
        { toolCalls: [{ id: "tc2", name: "t", input: {} }], usage: usage2 },
        { text: "done", usage: usage3 },
      ]);

      const { result } = await drainAgentLoop(
        baseParams(provider, { tools: [makeTool("t")] }),
      );

      expect(result.usage.inputTokens).toBe(450);
      expect(result.usage.outputTokens).toBe(160);
    });
  });

  // ──────────────────────────────────────
  // ChatRequest 构建正确性
  // ──────────────────────────────────────

  describe("ChatRequest 构建", () => {
    it("正确传递 model、systemPrompt、tools", async () => {
      const provider = mockTextProvider("OK");

      const tool = makeTool("my_tool");
      await drainAgentLoop(
        baseParams(provider, {
          model: "claude-sonnet",
          systemPrompt: "You are helpful",
          tools: [tool],
        }),
      );

      expect(provider.calls).toHaveLength(1);
      const req = provider.calls[0];
      expect(req.model).toBe("claude-sonnet");
      expect(req.systemPrompt).toBe("You are helpful");
      expect(req.tools).toHaveLength(1);
      expect(req.tools![0].name).toBe("my_tool");
    });

    it("无工具时 tools 为 undefined", async () => {
      const provider = mockTextProvider("OK");
      await drainAgentLoop(baseParams(provider, { tools: [] }));

      expect(provider.calls[0].tools).toBeUndefined();
    });

    it("多轮调用中消息历史正确积累", async () => {
      const provider = new MockLLMProvider([
        { toolCalls: [{ id: "tc1", name: "t", input: {} }] },
        { text: "done" },
      ]);

      await drainAgentLoop(
        baseParams(provider, { tools: [makeTool("t")] }),
      );

      // 第一次调用：[user message]
      expect(provider.calls[0].messages).toHaveLength(1);

      // 第二次调用：[user message, assistant(tool_use), user(tool_result)]
      expect(provider.calls[1].messages).toHaveLength(3);
      expect(provider.calls[1].messages[1].role).toBe("assistant");
      expect(provider.calls[1].messages[2].role).toBe("user");
      expect(provider.calls[1].messages[2].content[0].type).toBe("tool_result");
    });
  });

  // ──────────────────────────────────────
  // 状态不可变性
  // ──────────────────────────────────────

  describe("状态不可变性", () => {
    it("原始 messages 数组不被修改", async () => {
      const originalMessages = [userMessage("Hello")];
      const messagesSnapshot = [...originalMessages];

      const provider = new MockLLMProvider([
        { toolCalls: [{ id: "tc1", name: "t", input: {} }] },
        { text: "done" },
      ]);

      await drainAgentLoop(
        baseParams(provider, { messages: originalMessages, tools: [makeTool("t")] }),
      );

      expect(originalMessages).toEqual(messagesSnapshot);
      expect(originalMessages).toHaveLength(1);
    });
  });

  // ──────────────────────────────────────
  // 边界情况
  // ──────────────────────────────────────

  describe("边界情况", () => {
    it("maxTurns=0 → 立即终止", async () => {
      const provider = mockTextProvider("should not reach");
      const { result } = await drainAgentLoop(
        baseParams(provider, { maxTurns: 0 }),
      );

      expect(result.reason).toBe("max_turns");
      expect(provider.callCount).toBe(0);
    });

    it("maxTurns=1 → 只允许一轮工具调用", async () => {
      const provider = new MockLLMProvider([
        { toolCalls: [{ id: "tc1", name: "t", input: {} }] },
        { toolCalls: [{ id: "tc2", name: "t", input: {} }] },
      ]);

      const { result } = await drainAgentLoop(
        baseParams(provider, { tools: [makeTool("t")], maxTurns: 1 }),
      );

      expect(result.reason).toBe("max_turns");
      expect(provider.callCount).toBe(1);
    });

    it("LLM 返回混合内容（text + tool_use）", async () => {
      const provider = new MockLLMProvider([
        {
          text: "Let me read that file for you",
          toolCalls: [{ id: "tc1", name: "read", input: {} }],
        },
        { text: "Here are the contents" },
      ]);

      const { yields, result } = await drainAgentLoop(
        baseParams(provider, { tools: [makeTool("read")] }),
      );

      expect(result.reason).toBe("completed");

      // text_delta 应在 tool_start 之前 yield
      const types = yields.map((y) => y.type);
      const textIdx = types.indexOf("text_delta");
      const toolStartIdx = types.indexOf("tool_start");
      expect(textIdx).toBeLessThan(toolStartIdx);
    });
  });

  // ──────────────────────────────────────
  // 结果截断（maxResultChars）
  // ──────────────────────────────────────

  describe("maxResultChars 截断", () => {
    it("工具结果超出 maxResultChars 时自动截断", async () => {
      const provider = new MockLLMProvider([
        { toolCalls: [{ id: "tc1", name: "big_output", input: {} }] },
        { text: "OK" },
      ]);

      const bigTool: ToolDefinition = {
        name: "big_output",
        description: "returns a huge result",
        inputSchema: { type: "object" as const },
        maxResultChars: 50,
        async call() {
          return { content: "x".repeat(200) };
        },
      };

      const { yields } = await drainAgentLoop(
        baseParams(provider, { tools: [bigTool] }),
      );

      const toolEnds = filterYields(yields, "tool_end");
      expect(toolEnds).toHaveLength(1);
      if (toolEnds[0].type === "tool_end") {
        expect(toolEnds[0].result.content).toContain("[truncated:");
        expect(toolEnds[0].result.content.length).toBeLessThan(200);
      }

      // 截断后的结果也传递给了 LLM
      const secondCall = provider.calls[1];
      const toolResultMsg = secondCall.messages[secondCall.messages.length - 1];
      const toolResult = toolResultMsg.content[0];
      if (toolResult.type === "tool_result") {
        expect(toolResult.content).toContain("[truncated:");
      }
    });

    it("未超出 maxResultChars 时不截断", async () => {
      const provider = new MockLLMProvider([
        { toolCalls: [{ id: "tc1", name: "small", input: {} }] },
        { text: "OK" },
      ]);

      const smallTool: ToolDefinition = {
        name: "small",
        description: "returns a small result",
        inputSchema: { type: "object" as const },
        maxResultChars: 1000,
        async call() {
          return { content: "short result" };
        },
      };

      const { yields } = await drainAgentLoop(
        baseParams(provider, { tools: [smallTool] }),
      );

      const toolEnds = filterYields(yields, "tool_end");
      if (toolEnds[0].type === "tool_end") {
        expect(toolEnds[0].result.content).toBe("short result");
      }
    });

    it("错误结果不截断", async () => {
      const provider = new MockLLMProvider([
        { toolCalls: [{ id: "tc1", name: "err_tool", input: {} }] },
        { text: "OK" },
      ]);

      const errTool: ToolDefinition = {
        name: "err_tool",
        description: "returns an error",
        inputSchema: { type: "object" as const },
        maxResultChars: 10,
        async call() {
          return { content: "a very long error message that exceeds the limit", isError: true };
        },
      };

      const { yields } = await drainAgentLoop(
        baseParams(provider, { tools: [errTool] }),
      );

      const toolEnds = filterYields(yields, "tool_end");
      if (toolEnds[0].type === "tool_end") {
        // 错误消息完整保留，不被截断
        expect(toolEnds[0].result.content).not.toContain("[truncated:");
        expect(toolEnds[0].result.content).toContain("very long error");
      }
    });
  });

  // ──────────────────────────────────────
  // drainAgentLoop 便捷函数
  // ──────────────────────────────────────

  describe("drainAgentLoop", () => {
    it("收集所有 yield 事件和最终结果", async () => {
      const provider = mockTextProvider("Hello");
      const { yields, result } = await drainAgentLoop(baseParams(provider));

      expect(result.reason).toBe("completed");
      expect(yields.length).toBeGreaterThan(0);
      expect(yields.some((y) => y.type === "text_delta")).toBe(true);
      expect(yields.some((y) => y.type === "assistant_message")).toBe(true);
    });
  });
});
