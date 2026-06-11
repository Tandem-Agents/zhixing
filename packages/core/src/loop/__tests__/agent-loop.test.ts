import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../../events/event-bus.js";
import type { AgentEventMap } from "../../types/agent-events.js";
import type { TokenUsage } from "../../types/llm.js";
import type { ToolDefinition } from "../../types/tools.js";
import { userMessage } from "../../types/messages.js";
import { drainAgentLoop, runAgentLoop } from "../agent-loop.js";
import { MockLLMProvider, mockTextProvider } from "../mock-provider.js";
import { COMMITMENT_SIGNAL } from "../tool-executor.js";
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

    it("pure-text turn 无任何 turn-end 依赖时照常 return", async () => {
      const provider = mockTextProvider("hi");
      const { result } = await drainAgentLoop(baseParams(provider));
      expect(result.reason).toBe("completed");
    });

    // ─── P0-α: abort + failed 同时发生时 abort 优先 ───


    // ─── P1-ε: agent:run_end 事件携带 errorType ───

    it("agent:run_end 事件在 error 终止时携带 errorType (P1-ε)", async () => {
      // 订阅方可据此做差异化 UX,不再从 error 消息字符串 substring 匹配。
      // error 源用 LLM 调用抛错 —— loop 包装为 provider_error，run_end.errorType 取自 error.type。
      const provider: LLMProvider = {
        id: "mock",
        chat: () => {
          throw new AgentError("llm boom", "llm");
        },
      } as unknown as LLMProvider;
      const eventBus = new EventBus<AgentEventMap>();
      const runEndPayloads: Array<{ reason: string; errorType?: string }> = [];
      eventBus.on("agent:run_end", (data) =>
        runEndPayloads.push({ reason: data.reason, errorType: data.errorType }),
      );

      const { result } = await drainAgentLoop(
        baseParams(provider, { eventBus }),
      );

      expect(result.reason).toBe("error");
      expect(runEndPayloads).toHaveLength(1);
      expect(runEndPayloads[0]!.errorType).toBe("provider_error");
    });

    it("agent:run_end 事件在 completed 终止时不带 errorType (P1-ε)", async () => {
      const provider = mockTextProvider("ok");
      const eventBus = new EventBus<AgentEventMap>();
      const runEndPayloads: Array<{ reason: string; errorType?: string }> = [];
      eventBus.on("agent:run_end", (data) =>
        runEndPayloads.push({ reason: data.reason, errorType: data.errorType }),
      );

      await drainAgentLoop(baseParams(provider, { eventBus }));

      expect(runEndPayloads).toHaveLength(1);
      expect(runEndPayloads[0]!.reason).toBe("completed");
      expect(runEndPayloads[0]!.errorType).toBeUndefined();
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

    // ADR-007 Phase 2：committedToUser 的信号透传验证
    it("committedToUser=true → LLM 收到的 tool_result.content 末尾含 COMMITMENT_SIGNAL 标记", async () => {
      const provider = new MockLLMProvider([
        { toolCalls: [{ id: "tc1", name: "committer", input: {} }] },
        { text: "ok" },
      ]);

      const committer = makeTool("committer", async () => ({
        content: "Task created successfully",
        committedToUser: true,
      }));

      const { yields, result } = await drainAgentLoop(
        baseParams(provider, { tools: [committer] }),
      );

      expect(result.reason).toBe("completed");

      // 1. tool_end yield 保留原始 ToolResult（含 committedToUser，供 REPL/渲染层使用）
      const toolEnds = filterYields(yields, "tool_end");
      expect(toolEnds).toHaveLength(1);
      if (toolEnds[0].type === "tool_end") {
        expect(toolEnds[0].result.committedToUser).toBe(true);
      }

      // 2. 传递给 LLM 的 tool_result 消息 content 末尾必须含 COMMITMENT_SIGNAL
      //    （这是 LLM 实际"看到"的抑制信号）
      expect(provider.callCount).toBe(2);
      const secondCall = provider.calls[1];
      const lastMsg = secondCall.messages[secondCall.messages.length - 1];
      const toolResult = lastMsg.content[0];
      expect(toolResult.type).toBe("tool_result");
      if (toolResult.type === "tool_result") {
        expect(toolResult.content).toContain("Task created successfully");
        expect(toolResult.content).toContain(COMMITMENT_SIGNAL);
      }
    });

    it("committedToUser 缺失或 false → 不附加 COMMITMENT_SIGNAL", async () => {
      const provider = new MockLLMProvider([
        { toolCalls: [{ id: "tc1", name: "normal", input: {} }] },
        { text: "done" },
      ]);

      const normalTool = makeTool("normal", async () => ({
        content: "Operation completed",
      }));

      const { result } = await drainAgentLoop(
        baseParams(provider, { tools: [normalTool] }),
      );

      expect(result.reason).toBe("completed");
      const secondCall = provider.calls[1];
      const lastMsg = secondCall.messages[secondCall.messages.length - 1];
      const toolResult = lastMsg.content[0];
      if (toolResult.type === "tool_result") {
        expect(toolResult.content).not.toContain(COMMITMENT_SIGNAL);
      }
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

  // ──────────────────────────────────────
  // 中断 (abortReason / exitDelayMs / emit fired)
  // ──────────────────────────────────────

  describe("中断", () => {
    it("ext signal 已 aborted (defense) → AgentResult.aborted 携带 abortReason.kind='external' + exitDelayMs ≥ 0", async () => {
      // 验证两件事：
      // 1. abortReason.kind="external" —— createInterruptController 把外部 abort 映射为 external
      // 2. exitDelayMs ≥ 0 —— 已 aborted ext signal 场景下 abortFiredAt 仍正确记录
      //    (防御 EventTarget 标准:已 aborted signal 上 addEventListener 不触发)
      const provider = mockTextProvider("never reached");
      const ctrl = new AbortController();
      ctrl.abort();

      const { result } = await drainAgentLoop(
        baseParams(provider, { abortSignal: ctrl.signal }),
      );

      expect(result.reason).toBe("aborted");
      if (result.reason === "aborted") {
        expect(result.abortReason?.kind).toBe("external");
        expect(typeof result.exitDelayMs).toBe("number");
        expect(result.exitDelayMs).toBeGreaterThanOrEqual(0);
      }
      expect(provider.callCount).toBe(0);
    });

    it("emit 顺序: agent:run_start → interrupt:fired → agent:run_end, fired 单次", async () => {
      // emit fired 收敛在 emitRunEnd 单点;严格在 run_end 之前(单向蕴含,非数量对等)
      const provider = mockTextProvider("ignored");
      const ctrl = new AbortController();
      ctrl.abort();

      const eventBus = new EventBus<AgentEventMap>();
      const order: string[] = [];
      eventBus.on("agent:run_start", () => { order.push("run_start"); });
      eventBus.on("interrupt:fired", () => { order.push("interrupt:fired"); });
      eventBus.on("agent:run_end", () => { order.push("run_end"); });

      await drainAgentLoop(
        baseParams(provider, { abortSignal: ctrl.signal, eventBus }),
      );

      expect(order).toEqual(["run_start", "interrupt:fired", "run_end"]);
    });

    it("interrupt:fired payload: reason 类型化, exitDelayMs 与 AgentResult 一致, toolGraceMs=0, interruptedTurnIndex=0", async () => {
      // payload 字段一致性:exitDelayMs 由同一 const 派生 → AgentResult 与 EventBus 完全相同;
      // 订阅方不依赖 RunResult 也能拿到精准延迟;P95 SLO 监控用 exitDelayMs - toolGraceMs 隔离 loop 框架延迟
      const provider = mockTextProvider("ignored");
      const ctrl = new AbortController();
      ctrl.abort();

      const eventBus = new EventBus<AgentEventMap>();
      let fired: AgentEventMap["interrupt:fired"] | undefined;
      eventBus.on("interrupt:fired", (e) => { fired = e; });

      const { result } = await drainAgentLoop(
        baseParams(provider, { abortSignal: ctrl.signal, eventBus }),
      );

      expect(result.reason).toBe("aborted");
      expect(fired).toBeDefined();
      if (result.reason === "aborted" && fired) {
        expect(fired.reason?.kind).toBe("external");
        expect(fired.exitDelayMs).toBe(result.exitDelayMs);
        expect(typeof fired.exitDelayMs).toBe("number");
        expect(fired.exitDelayMs).toBeGreaterThanOrEqual(0);
        expect(fired.toolGraceMs).toBe(0);
        // abort 在 turn 0 之前触发 → interruptedTurnIndex = 0
        expect(fired.interruptedTurnIndex).toBe(0);
      }
    });

    it("ext signal 中途 abort → interruptedTurnIndex 等于已完成 turn 数 (state.turnCount)", async () => {
      // turn 1 中 tool 触发 abort, 后续 turn 1 走完 turn-end 副作用,
      // state 推进到 turnCount=1, 下次迭代顶 abort guard 触发 → interruptedTurnIndex=1
      // 验证 interruptedTurnIndex 取 state.turnCount(0-indexed)而不是 newTurnCount(1-indexed 已完成数)
      const ctrl = new AbortController();
      const provider = new MockLLMProvider([
        { toolCalls: [{ id: "tc1", name: "t", input: {} }] },
        { text: "should never reach" },
      ]);
      const tool = makeTool("t", async () => {
        ctrl.abort();
        return { content: "ok" };
      });

      const eventBus = new EventBus<AgentEventMap>();
      let fired: AgentEventMap["interrupt:fired"] | undefined;
      eventBus.on("interrupt:fired", (e) => { fired = e; });

      const { result } = await drainAgentLoop(
        baseParams(provider, {
          tools: [tool],
          abortSignal: ctrl.signal,
          eventBus,
        }),
      );

      expect(result.reason).toBe("aborted");
      expect(fired?.interruptedTurnIndex).toBe(1);
    });

    it("max_turns 路径不 emit fired (与 abort 体系平行)", async () => {
      // max_turns 是"达到上限"的内部限制,不携带 abortReason、不 emit interrupt:fired;
      // 与 abort 严格分体系,REPL 渲染走"max turns reached"而非"interrupted"
      const provider = new MockLLMProvider([
        { toolCalls: [{ id: "tc1", name: "t", input: {} }] },
        { toolCalls: [{ id: "tc2", name: "t", input: {} }] },
        { text: "should never reach" },
      ]);

      const eventBus = new EventBus<AgentEventMap>();
      let firedCount = 0;
      eventBus.on("interrupt:fired", () => { firedCount++; });

      const { result } = await drainAgentLoop(
        baseParams(provider, {
          tools: [makeTool("t")],
          maxTurns: 2,
          eventBus,
        }),
      );

      expect(result.reason).toBe("max_turns");
      expect(firedCount).toBe(0);
    });

    it("abort 与 max_turns 同时满足 → abort 优先 (guard 顺序)", async () => {
      // turn 1 中 tool 触发 abort, 完成后 state.turnCount=1=maxTurns;
      // 下次迭代顶 abort guard 优先于 max_turns guard 命中 → reason="aborted"
      // 验证 guard 顺序调换:abort 体现用户/外部明确意图,max_turns 是内部限制,
      // 同时满足时 abort 胜出(与 termination.ts "abort 优先于 context_overflow" 哲学对称)
      const ctrl = new AbortController();
      const provider = new MockLLMProvider([
        { toolCalls: [{ id: "tc1", name: "t", input: {} }] },
        { text: "should never reach" },
      ]);
      const tool = makeTool("t", async () => {
        ctrl.abort();
        return { content: "ok" };
      });

      const { result } = await drainAgentLoop(
        baseParams(provider, {
          tools: [tool],
          maxTurns: 1,
          abortSignal: ctrl.signal,
        }),
      );

      expect(result.reason).toBe("aborted");
      expect(provider.callCount).toBe(1);
    });

    // ─── finalizeRun 单点 abort 优先转换 ───

    it("LLM error 路径 + abort 同时满足 → finalizeRun 自动覆盖为 aborted (abort 优先于 error)", async () => {
      // 实际场景:用户按 Esc 时 LLM SDK 抛 AbortError → llm-call 包成 llmResult.error。
      // 用户体验上"按了 Esc 看到出错反馈"是错的——finalizeRun 单点检查 controller.signal.aborted
      // 自动把 error 覆盖为 aborted,与 termination.ts "abort 优先于 context_overflow" 哲学对称。
      const ctrl = new AbortController();
      const provider = new MockLLMProvider([{ text: "ignored" }]);

      const eventBus = new EventBus<AgentEventMap>();
      let fired: AgentEventMap["interrupt:fired"] | undefined;
      eventBus.on("interrupt:fired", (e) => { fired = e; });

      // 自定义 callLLM 模拟"chat in flight 时被 abort,然后 stream 抛 error"
      const { result } = await drainAgentLoop(
        baseParams(provider, {
          abortSignal: ctrl.signal,
          eventBus,
          deps: {
            callLLM: async function* () {
              yield { type: "message_start" };
              ctrl.abort();   // abort 触发(模拟 SDK 检测到 abort 即将抛错)
              yield { type: "error", error: new Error("provider error after abort") };
            },
          },
        }),
      );

      // abort 优先 —— result 是 aborted 而非 error,用户看到"已中断"
      expect(result.reason).toBe("aborted");
      if (result.reason === "aborted") {
        expect(result.abortReason?.kind).toBe("external");
        expect(typeof result.exitDelayMs).toBe("number");
      }
      // emit fired 走 abort 路径(单点统一)
      expect(fired).toBeDefined();
      expect(fired?.reason?.kind).toBe("external");
    });

    it("pre-text-return completed 路径 + abort 同时 → finalizeRun 覆盖为 aborted (race window 防御)", async () => {
      // 场景:LLM 返回 pure text,turn-end 副作用（段评估）期间外部 abort 触发但
      // 评估返回 modified:false。主路径走 return completed,但 controller.signal
      // 已 aborted —— finalizeRun 自动覆盖,避免 abort 被静默丢失。
      const ctrl = new AbortController();
      const provider = mockTextProvider("hello");
      const segmentManager = {
        evaluate: async () => {
          ctrl.abort();
          return { decision: { kind: "pass", reason: "below-optimal" }, modified: false };
        },
      } as unknown as import("../../context/segment/segment-manager.js").SegmentManager;

      const eventBus = new EventBus<AgentEventMap>();
      let fired: AgentEventMap["interrupt:fired"] | undefined;
      eventBus.on("interrupt:fired", (e) => { fired = e; });

      const { result } = await drainAgentLoop(
        baseParams(provider, {
          segmentManager,
          abortSignal: ctrl.signal,
          eventBus,
        }),
      );

      // completed 被 finalizeRun 自动覆盖为 aborted
      expect(result.reason).toBe("aborted");
      if (result.reason === "aborted") {
        expect(result.abortReason?.kind).toBe("external");
      }
      // emit fired 也触发(单点收敛)
      expect(fired).toBeDefined();
    });

    // ─── 端到端 abort 路径:cleanup 注入 partial/placeholder 让 messages 协议合规 ───

    it("Tool 阶段 abort(串行路径):newMessages 协议合规 (每个 tool_use 配对 tool_result)", async () => {
      // 验证 cleanup 注入 placeholder 让 messages 协议合规 ——
      // 否则下一轮 LLM 调用会因残缺 tool_use 报 400。
      //
      // "前 K 完成 + 后 N-K 未启动" 边界是串行分支特有形态(并发分支入口已启动全 N 个);
      // 显式 isParallelSafe=false 锁定串行路径。并发路径的协议合规另有专属覆盖
      // (tool-executor.test.ts · 并发模式 abort 段)。
      const ctrl = new AbortController();
      let toolCount = 0;
      const provider = new MockLLMProvider([
        {
          toolCalls: [
            { id: "tc1", name: "t", input: {} },
            { id: "tc2", name: "t", input: {} },
            { id: "tc3", name: "t", input: {} },
          ],
        },
        { text: "should never reach" },
      ]);

      const tool: ToolDefinition = {
        ...makeTool("t", async () => {
          toolCount++;
          if (toolCount === 2) {
            ctrl.abort();
          }
          return { content: `done-${toolCount}` };
        }),
        isParallelSafe: false,
      };

      const yields: AgentYield[] = [];
      const gen = runAgentLoop(
        baseParams(provider, {
          tools: [tool],
          abortSignal: ctrl.signal,
        }),
      );

      let result: import("../types.js").AgentResult | undefined;
      while (true) {
        const { value, done } = await gen.next();
        if (done) {
          result = value;
          break;
        }
        yields.push(value);
      }

      expect(result?.reason).toBe("aborted");

      // turn_complete yield 过 (with llmResult.usage,反映 LLM 实际 tokens)
      const turnCompletes = filterYields(yields, "turn_complete");
      expect(turnCompletes).toHaveLength(1);
      if (turnCompletes[0]?.type === "turn_complete") {
        expect(turnCompletes[0].usage.outputTokens).toBeGreaterThan(0);
      }

      // tool_end yield: tc1 + tc2 完成 + tc3 placeholder
      const toolEnds = filterYields(yields, "tool_end");
      expect(toolEnds.length).toBeGreaterThanOrEqual(3);
      // 检查 tc3 是 placeholder (isError=true,content 含 "cancelled")
      const tc3End = toolEnds.find(
        (e) => e.type === "tool_end" && e.id === "tc3",
      );
      expect(tc3End).toBeDefined();
      if (tc3End?.type === "tool_end") {
        expect(tc3End.result.isError).toBe(true);
        expect(tc3End.result.content.toLowerCase()).toContain("cancel");
      }
    });

    it("Tool catch 块 abort 抛 AbortError:newMessages 协议合规 (每个 tool_use 配且仅配一个 tool_result)", async () => {
      // 修复回归:tool-executor catch 块 abort 路径之前 yield tool_end + cleanup placeholder
      // 重复合成 → 同一 tool_use 收两个 tool_end → trackMessages push 两个 tool_result
      // → user message 含同 toolUseId 的两个 tool_result → Anthropic API 报 400。
      // 修复后 catch 块只 break,cleanup 注入唯一 placeholder,1:1 对应。
      const ctrl = new AbortController();
      let attemptCount = 0;
      const provider = new MockLLMProvider([
        {
          toolCalls: [
            { id: "tc1", name: "t", input: {} },
            { id: "tc2", name: "t", input: {} },
            { id: "tc3", name: "t", input: {} },
          ],
        },
        { text: "should never reach" },
      ]);

      const tool = makeTool("t", async () => {
        attemptCount++;
        if (attemptCount === 1) {
          return { content: "done-1" };
        }
        // 第 2 个工具 await 期间响应 abort 抛 AbortError
        ctrl.abort();
        throw new Error("AbortError: aborted by signal");
      });

      const yields: AgentYield[] = [];
      const gen = runAgentLoop(
        baseParams(provider, {
          tools: [tool],
          abortSignal: ctrl.signal,
        }),
      );

      let result: import("../types.js").AgentResult | undefined;
      while (true) {
        const { value, done } = await gen.next();
        if (done) {
          result = value;
          break;
        }
        yields.push(value);
      }

      expect(result?.reason).toBe("aborted");

      // 收集 LLM 实际 yield 的 tool_use ids (通过 assistant_message 反推)
      const assistantMessages = filterYields(yields, "assistant_message");
      const toolUseIds = new Set<string>();
      for (const am of assistantMessages) {
        if (am.type !== "assistant_message") continue;
        for (const block of am.message.content) {
          if (block.type === "tool_use") {
            toolUseIds.add(block.id);
          }
        }
      }
      expect(toolUseIds).toEqual(new Set(["tc1", "tc2", "tc3"]));

      // tool_end yields:每个 tool_use id 必须出现且仅出现一次 (1:1 对应)
      const toolEnds = filterYields(yields, "tool_end");
      const toolEndIdCounts = new Map<string, number>();
      for (const te of toolEnds) {
        if (te.type !== "tool_end") continue;
        toolEndIdCounts.set(te.id, (toolEndIdCounts.get(te.id) ?? 0) + 1);
      }

      // 验证 1:1 对应 + 无重复
      expect(toolEndIdCounts.get("tc1")).toBe(1); // 完成的工具
      expect(toolEndIdCounts.get("tc2")).toBe(1); // 修复前会是 2 (catch + placeholder), 修复后只有 placeholder
      expect(toolEndIdCounts.get("tc3")).toBe(1); // 未执行的 placeholder
      expect(toolEndIdCounts.size).toBe(3); // 没有意外的 toolUseId
    });

    it("LLM 阶段 abort:yield assistant_message with [interrupted] 标记", async () => {
      // 验证 cleanup 用 assemblePartialMessage 注入 [interrupted] 标记的 partialAssistant 被 yield。
      const ctrl = new AbortController();
      const provider = new MockLLMProvider([{ text: "ignored" }]);

      const callLLM: import("../types.js").AgentLoopDeps["callLLM"] =
        async function* () {
          yield { type: "message_start" };
          yield { type: "text_delta", text: "Partial response" };
          ctrl.abort();
        };

      const yields: AgentYield[] = [];
      const gen = runAgentLoop(
        baseParams(provider, {
          abortSignal: ctrl.signal,
          deps: { callLLM },
        }),
      );

      let result: import("../types.js").AgentResult | undefined;
      while (true) {
        const { value, done } = await gen.next();
        if (done) {
          result = value;
          break;
        }
        yields.push(value);
      }

      expect(result?.reason).toBe("aborted");

      // 应有一个 assistant_message yield 含 [interrupted] 标记 (cleanup 注入)
      const assistantMessages = filterYields(yields, "assistant_message");
      expect(assistantMessages.length).toBeGreaterThan(0);
      if (assistantMessages[0]?.type === "assistant_message") {
        const textBlock = assistantMessages[0].message.content.find(
          (b) => b.type === "text",
        );
        expect(textBlock).toBeDefined();
        if (textBlock?.type === "text") {
          expect(textBlock.text).toContain("[interrupted]");
          // 原 partial text 也保留
          expect(textBlock.text).toContain("Partial response");
        }
      }
    });

    it("消费者 generator.return() 中途打断 → finally 兜底补发 aborted (origin='consumer-return')", async () => {
      // 场景:消费者用 for-await-of 循环中 break,或显式 gen.return() 提前退出。
      // 主路径未走到 finalizeRun → finally 兜底补发,防止订阅方 spinner 永不结束。
      // abortReason.origin="consumer-return" 让订阅方区分"用户按键中断"vs"消费者主动 cancel"。
      const provider = new MockLLMProvider([
        { text: "long response that consumer interrupts" },
      ]);

      const eventBus = new EventBus<AgentEventMap>();
      const events: { name: string; data: unknown }[] = [];
      eventBus.on("agent:run_start", (data) => { events.push({ name: "run_start", data }); });
      eventBus.on("interrupt:fired", (data) => { events.push({ name: "fired", data }); });
      eventBus.on("agent:run_end", (data) => { events.push({ name: "run_end", data }); });

      const gen = runAgentLoop(baseParams(provider, { eventBus }));

      // 消费 1 个 yield 让 generator 进入 yield 暂停态
      await gen.next();
      // gen.return() 注入 abrupt return,触发 finally
      const { done } = await gen.return(undefined as never);

      expect(done).toBe(true);

      // finally 补发了 fired 和 run_end
      const firedEvent = events.find((e) => e.name === "fired");
      const runEndEvent = events.find((e) => e.name === "run_end");
      expect(firedEvent).toBeDefined();
      expect(runEndEvent).toBeDefined();

      // fired 的 reason 标记 origin="consumer-return"(区分用户中断)
      const firedData = firedEvent?.data as AgentEventMap["interrupt:fired"];
      expect(firedData.reason).toEqual({ kind: "external", origin: "consumer-return" });

      // run_end 的 reason 是 "aborted"(消费者 cancel 也属于 abort 体系)
      const runEndData = runEndEvent?.data as AgentEventMap["agent:run_end"];
      expect(runEndData.reason).toBe("aborted");

      // 顺序:fired 必然在 run_end 之前
      const firedIdx = events.findIndex((e) => e.name === "fired");
      const runEndIdx = events.findIndex((e) => e.name === "run_end");
      expect(firedIdx).toBeLessThan(runEndIdx);
    });
  });

  // ──────────────────────────────────────
  // 父子 abort 传播
  // ──────────────────────────────────────

  describe("父子 abort 传播", () => {
    it("parentSignal 已 aborted → 立即退出 with abortReason.kind='parent-abort' + parentReason 链", async () => {
      // 子 agent 启动时父已 aborted: controller 同步进入 aborted with parent-abort,
      // 顶部 abort guard 不消耗任何 LLM call
      const provider = mockTextProvider("never reached");
      const parent = new AbortController();
      parent.abort({ kind: "user-cancel", source: "esc", pressedAt: 100 });

      const { result } = await drainAgentLoop(
        baseParams(provider, { parentSignal: parent.signal }),
      );

      expect(result.reason).toBe("aborted");
      if (result.reason === "aborted") {
        expect(result.abortReason?.kind).toBe("parent-abort");
        if (result.abortReason?.kind === "parent-abort") {
          // parent reason 链路: 子能看到父的 user-cancel 原因
          expect(result.abortReason.parentReason?.kind).toBe("user-cancel");
        }
      }
      expect(provider.callCount).toBe(0);
    });

    it("parentSignal 中途触发 → 子 agent 终止 with parent-abort, 父 reason 透传", async () => {
      // 第一轮工具调用中触发 parent abort, 验证 abort 在 stream 间隙被检测到
      const parent = new AbortController();
      const provider = new MockLLMProvider([
        { toolCalls: [{ id: "tc1", name: "t", input: {} }] },
        { text: "should never reach" },
      ]);
      const tool = makeTool("t", async () => {
        // 工具内部触发 parent abort 模拟"父 agent 决定取消所有子"
        parent.abort({ kind: "user-cancel", source: "ctrl-c", pressedAt: 200 });
        return { content: "tool done" };
      });

      const { result } = await drainAgentLoop(
        baseParams(provider, { tools: [tool], parentSignal: parent.signal }),
      );

      expect(result.reason).toBe("aborted");
      if (result.reason === "aborted") {
        expect(result.abortReason?.kind).toBe("parent-abort");
        if (result.abortReason?.kind === "parent-abort") {
          expect(result.abortReason.parentReason?.kind).toBe("user-cancel");
        }
      }
    });

    it("parentSignal + abortSignal 同时传, parentSignal 先触发 → kind='parent-abort' (first-wins)", async () => {
      // 两类来源同时存在时, abort 来源 reason 由 first-wins 决定 (abortWithReason 幂等)
      const provider = mockTextProvider("never reached");
      const parent = new AbortController();
      const ext = new AbortController();
      parent.abort({ kind: "user-cancel", source: "esc", pressedAt: 50 });

      const { result } = await drainAgentLoop(
        baseParams(provider, { parentSignal: parent.signal, abortSignal: ext.signal }),
      );

      expect(result.reason).toBe("aborted");
      if (result.reason === "aborted") {
        // parent 已 aborted → controller 创建时同步进入 parent-abort, ext 后续 abort 不覆盖
        expect(result.abortReason?.kind).toBe("parent-abort");
      }
    });

    it("parentSignal + abortSignal 同时传, abortSignal 先触发 → kind='external' (first-wins)", async () => {
      // 反向 first-wins: ext 先 abort → external reason 胜出, 之后 parent abort 不覆盖
      const provider = mockTextProvider("never reached");
      const parent = new AbortController();
      const ext = new AbortController();
      ext.abort();

      const { result } = await drainAgentLoop(
        baseParams(provider, { parentSignal: parent.signal, abortSignal: ext.signal }),
      );

      expect(result.reason).toBe("aborted");
      if (result.reason === "aborted") {
        expect(result.abortReason?.kind).toBe("external");
      }
    });

    it("loop 内部 abort 不波及父 signal(对称契约:abort 仅父→子,反向不向上)", async () => {
      // 子内部 abort(abortSignal 工具内触发)→ loop aborted with kind="external",
      // 父 controller 的 signal 不应被反向波及。这是 forkController 设计契约 ——
      // child.abort 不向上冒泡 —— 在 agent-loop 集成层面的锁。
      // 没有这条断言,未来若有人误把"子 abort 反向触发父"的捷径加进来,
      // 父 turn 会被无辜杀掉,产品级承诺崩塌
      const parent = new AbortController();
      const ext = new AbortController();
      const provider = new MockLLMProvider([
        { toolCalls: [{ id: "tc1", name: "t", input: {} }] },
        { text: "should never reach" },
      ]);
      const tool = makeTool("t", async () => {
        ext.abort();
        return { content: "tool done" };
      });

      const { result } = await drainAgentLoop(
        baseParams(provider, {
          tools: [tool],
          parentSignal: parent.signal,
          abortSignal: ext.signal,
        }),
      );

      expect(result.reason).toBe("aborted");
      if (result.reason === "aborted") {
        expect(result.abortReason?.kind).toBe("external");
      }
      // 关键不变量:子 abort 不反向波及父 —— 父 signal 仍 pristine
      expect(parent.signal.aborted).toBe(false);
    });
  });

  // ──────────────────────────────────────
  // tokenEstimator per-LLM-call 校准
  // ──────────────────────────────────────
  //
  // 校准 baseline 从 caller 侧（state.messages + 最终 cumulative usage）下沉到
  // agent-loop per-call（messagesForLLM ↔ 单次 inputTokens），让系数与 LLM 实际
  // 处理的 size 对账（含 turn-context 注入后的视图）。

  describe("tokenEstimator per-LLM-call 校准", () => {
    function makeMockEstimator() {
      const calls: { estimated: number; actual: number }[] = [];
      const messagesEstimateCalls: number[] = [];
      return {
        estimator: {
          estimateMessage: () => 0,
          estimateMessages: (msgs: readonly import("../../types/messages.js").Message[]) => {
            messagesEstimateCalls.push(msgs.length);
            return msgs.length * 10;
          },
          estimateText: () => 0,
          // calibrate 全量对账契约：estimated 必须含 system + messages + tools，
          // 与 API 真值 inputTokens 维度对齐（agent-loop.ts 校准点强制此契约）
          estimateTools: () => 0,
          calibrate: (estimated: number, actual: number) => {
            calls.push({ estimated, actual });
          },
          calibrationFactor: 1.0,
        },
        calls,
        messagesEstimateCalls,
      };
    }

    it("注册 estimator → 每次成功 LLM call 都调一次 calibrate", async () => {
      const provider = new MockLLMProvider([
        { toolCalls: [{ id: "tc1", name: "t", input: {} }], usage: { inputTokens: 200, outputTokens: 30 } },
        { text: "done", usage: { inputTokens: 220, outputTokens: 25 } },
      ]);
      const { estimator, calls } = makeMockEstimator();

      await drainAgentLoop(
        baseParams(provider, { tools: [makeTool("t")], tokenEstimator: estimator }),
      );

      expect(calls).toHaveLength(2);
      expect(calls[0]!.actual).toBe(200);
      expect(calls[1]!.actual).toBe(220);
      // 第二次 call 之前 messages 多了 assistant + tool_result 两条 → estimated 单调增
      expect(calls[1]!.estimated).toBeGreaterThan(calls[0]!.estimated);
    });

    it("不注册 estimator → agent-loop 不抛错也不 calibrate", async () => {
      const provider = mockTextProvider("hello");
      const { yields, result } = await drainAgentLoop(baseParams(provider));
      expect(result.reason).toBe("completed");
      expect(filterYields(yields, "assistant_message")).toHaveLength(1);
    });

    it("inputTokens=0 → 跳过 calibrate（防御 abort/未送达样本）", async () => {
      const provider = new MockLLMProvider([
        { text: "ok", usage: { inputTokens: 0, outputTokens: 10 } },
      ]);
      const { estimator, calls } = makeMockEstimator();

      await drainAgentLoop(baseParams(provider, { tokenEstimator: estimator }));

      expect(calls).toHaveLength(0);
    });

    it("error 路径不 calibrate（provider error event）", async () => {
      const provider = new MockLLMProvider([{ error: new Error("provider boom") }]);
      const { estimator, calls } = makeMockEstimator();

      const { result } = await drainAgentLoop(
        baseParams(provider, { tokenEstimator: estimator }),
      );
      expect(result.reason).toBe("error");
      expect(calls).toHaveLength(0);
    });
  });

});
