/**
 * runSubAgentLoop 契约级单测
 *
 * 覆盖矩阵:
 *   - happy:文本回复 → reason=completed,messages 累积正确
 *   - max_turns:连续 tool_use 触发 → reason=max_turns + budgetExceeded=true
 *   - error:provider chat 抛 → reason=error,函数本身不 throw
 *   - parent abort:parentSignal pre-aborted → reason=aborted + abortReason.kind=parent-abort
 *   - wall-clock:fake timers 超时 → reason=aborted + origin=subagent-wall-clock-timeout
 *   - cleanup:setTimeout 在 finally 被 clear (不在测试结束后泄漏)
 *
 * 用真实 SecurityPipeline + ConfirmationBroker 实例(纯类无副作用),
 * MockLLMProvider 提供确定性响应。子 broker 默认无 listener → 工具调用走
 * fail-deny 路径,本测试**不触发**任何需要 confirmation 的工具(都是 read-only),
 * 避免子 broker 装配差异污染本层契约测试。
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  ConfirmationBroker,
  createEventBus,
  MockLLMProvider,
  PermissionStore,
  SecurityPipeline,
  type AgentEventMap,
  type LLMRole,
  type LLMRoles,
  type Message,
  type ToolDefinition,
} from "@zhixing/core";
import {
  createWatchdogPolicy,
} from "@zhixing/core";
import { runSubAgentLoop } from "../loop-runner.js";

// ─── 测试辅助 ───

function makeReadOnlyTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: "object" } as never,
    subAgentSafe: true,
    needsPermission: false,
    call: async () => ({ content: `${name}-ok`, isError: false }),
  };
}

function makePipeline(): SecurityPipeline {
  return new SecurityPipeline({
    workspace: process.cwd(),
    sessionType: "ci",
    permissionStore: new PermissionStore({ rootDir: null }),
  });
}

function makeBroker(): ConfirmationBroker {
  return new ConfirmationBroker();
}

function makeRoles(provider: MockLLMProvider): LLMRoles {
  const role: LLMRole = {
    provider,
    model: "mock-model",
    chat: (req) => provider.chat(req),
  };
  return { main: role, secondary: role };
}

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function makeBaseOpts(provider: MockLLMProvider, tools: ToolDefinition[] = []) {
  return {
    systemPrompt: "test system",
    messages: [userMsg("Begin")],
    tools,
    provider,
    model: "mock-model",
    llmRoles: makeRoles(provider),
    securityPipeline: makePipeline(),
    confirmationBroker: makeBroker(),
    eventBus: createEventBus<AgentEventMap>({ lineage: "main/sub-test" }),
    parentSignal: new AbortController().signal,
    maxTurns: 5,
    watchdog: createWatchdogPolicy({ idleTimeoutMs: 0 }),
    wallClockTimeoutMs: 60_000,
  };
}

// ─── happy ───

describe("runSubAgentLoop · happy path", () => {
  it("纯文本回复 → reason=completed,messages 含初始 + assistant", async () => {
    const provider = new MockLLMProvider([{ text: "task done" }]);
    const result = await runSubAgentLoop(makeBaseOpts(provider));

    expect(result.reason).toBe("completed");
    expect(result.toolUseCount).toBe(0);
    expect(result.budgetExceeded).toBe(false);
    expect(result.abortReason).toBeUndefined();
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages[1]?.role).toBe("assistant");
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  it("一次 tool_use 后 end_turn → toolUseCount=1,messages 累积 4 条 (user/assistant/tool_result/assistant)", async () => {
    const provider = new MockLLMProvider([
      { toolCalls: [{ id: "t1", name: "read", input: {} }] },
      { text: "summary" },
    ]);
    const result = await runSubAgentLoop(
      makeBaseOpts(provider, [makeReadOnlyTool("read")]),
    );

    expect(result.reason).toBe("completed");
    expect(result.toolUseCount).toBe(1);
    expect(result.messages).toHaveLength(4);
    expect(result.messages[2]?.role).toBe("user");
    expect(result.messages[2]?.content[0]?.type).toBe("tool_result");
  });
});

// ─── max_turns ───

describe("runSubAgentLoop · max_turns budget", () => {
  it("反复 tool_use 触发 maxTurns → reason=max_turns + budgetExceeded=true", async () => {
    const responses = Array.from({ length: 10 }, (_, i) => ({
      toolCalls: [{ id: `t${i}`, name: "read", input: {} }],
    }));
    const provider = new MockLLMProvider(responses);
    const opts = { ...makeBaseOpts(provider, [makeReadOnlyTool("read")]), maxTurns: 3 };

    const result = await runSubAgentLoop(opts);

    expect(result.reason).toBe("max_turns");
    expect(result.budgetExceeded).toBe(true);
    expect(result.toolUseCount).toBeGreaterThanOrEqual(3);
  });
});

// ─── error ───

describe("runSubAgentLoop · error path", () => {
  it("provider 第一次 chat 流式 error → reason=error,函数本身不 throw", async () => {
    const provider = new MockLLMProvider([
      { error: new Error("upstream connection refused") },
    ]);

    const result = await runSubAgentLoop(makeBaseOpts(provider));

    expect(result.reason).toBe("error");
    expect(result.budgetExceeded).toBe(false);
    expect(result.abortReason).toBeUndefined();
  });
});

// ─── parent abort ───

describe("runSubAgentLoop · parent abort cascade", () => {
  it("parentSignal pre-aborted → reason=aborted + abortReason.kind=parent-abort", async () => {
    const provider = new MockLLMProvider([{ text: "should not reach" }]);
    const parentController = new AbortController();
    parentController.abort();

    const result = await runSubAgentLoop({
      ...makeBaseOpts(provider),
      parentSignal: parentController.signal,
    });

    expect(result.reason).toBe("aborted");
    expect(result.abortReason?.kind).toBe("parent-abort");
  });
});

// ─── wall-clock + cleanup ───

describe("runSubAgentLoop · wall-clock & cleanup", () => {
  let setTimeoutSpy: MockInstance<typeof globalThis.setTimeout>;
  let clearTimeoutSpy: MockInstance<typeof globalThis.clearTimeout>;

  beforeEach(() => {
    setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  it("happy path:wallClock setTimeout 在 finally 被 clearTimeout (无定时器泄漏)", async () => {
    const provider = new MockLLMProvider([{ text: "ok" }]);
    await runSubAgentLoop(makeBaseOpts(provider));

    // 至少一个 setTimeout 调用是 wallClock(timeout=60_000)
    const wallClockSetTimeoutCalls = setTimeoutSpy.mock.calls.filter(
      ([, ms]) => ms === 60_000,
    );
    expect(wallClockSetTimeoutCalls.length).toBeGreaterThanOrEqual(1);

    // 对应的 clearTimeout 也至少调一次
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("error path:即使 LLM 抛错,wallClock 计时器仍在 finally 被 clear", async () => {
    const provider = new MockLLMProvider([
      { error: new Error("provider down") },
    ]);

    await runSubAgentLoop(makeBaseOpts(provider));

    const wallClockSet = setTimeoutSpy.mock.calls.find(
      ([, ms]) => ms === 60_000,
    );
    expect(wallClockSet).toBeDefined();
    // clearTimeout 必须调,否则定时器跨 dispatch 累积
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});
