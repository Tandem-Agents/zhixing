/**
 * runSubAgentLoop 契约级单测
 *
 * 覆盖矩阵:
 *   - happy:文本回复 → reason=completed,budgetExceededKind=undefined
 *   - max_turns:连续 tool_use 触发 → reason=max_turns + budgetExceededKind="max_turns"
 *   - max_tokens:LLM 返回 usage 超阈 → reason=aborted + budgetExceededKind="max_tokens"
 *     + abortReason.origin="subagent-max-tokens-exceeded"
 *   - error:provider chat 抛 → reason=error,函数本身不 throw
 *   - parent abort:parentSignal pre-aborted → reason=aborted + abortReason.kind=parent-abort
 *     + budgetExceededKind=undefined(parent abort 不是软上限)
 *   - wall-clock:fake timers 超时 → reason=aborted + budgetExceededKind="wall_clock"
 *   - cleanup:setTimeout 在 finally 被 clear + usageListener 被 off (不泄漏)
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
import { deriveBudgetExceededKind, runSubAgentLoop } from "../loop-runner.js";

// ─── 测试辅助 ───

function makeReadOnlyTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: "object" } as never,
    needsPermission: false,
    call: async () => ({ content: `${name}-ok`, isError: false }),
  };
}

function makePipeline(): SecurityPipeline {
  return new SecurityPipeline({
    trustContext: { kind: "workspace", dir: process.cwd() },
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
  return { main: role, light: role, power: role };
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
    // 故意拉到极大值,避免常规测试路径意外触发 token 软上限;maxTokens 专属
    // describe 段会显式覆盖
    maxTokens: 10_000_000,
    // 同上,默认大阈值;context_overflow 专属 describe 段会显式覆盖
    riskMaxTokens: 10_000_000,
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
    expect(result.budgetExceededKind).toBeUndefined();
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

// ─── thinking 透传 ───

describe("runSubAgentLoop · loopThinking 透传", () => {
  it("loopThinking → 子 loop 的 ChatRequest.thinking（与 model 配对，role-agnostic）", async () => {
    const provider = new MockLLMProvider([{ text: "done" }]);
    await runSubAgentLoop({
      ...makeBaseOpts(provider),
      loopThinking: { mode: "effort", effort: "max" },
    });

    expect(provider.calls[0]?.thinking).toEqual({
      mode: "effort",
      effort: "max",
    });
  });

  it("roleThinking 映射不喂 loop —— 仅 loopThinking 决定 ChatRequest.thinking", async () => {
    const provider = new MockLLMProvider([{ text: "done" }]);
    // 只给 roleThinking.main、不给 loopThinking → loop 不应取 roleThinking.main
    await runSubAgentLoop({
      ...makeBaseOpts(provider),
      roleThinking: { main: { mode: "on" } },
    });

    expect(provider.calls[0]?.thinking).toBeUndefined();
  });

  it("未传 loopThinking → ChatRequest.thinking 为 undefined（不发思考参数）", async () => {
    const provider = new MockLLMProvider([{ text: "done" }]);
    await runSubAgentLoop(makeBaseOpts(provider));

    expect(provider.calls[0]?.thinking).toBeUndefined();
  });
});

// ─── max_turns ───

describe("runSubAgentLoop · max_turns budget", () => {
  it('反复 tool_use 触发 maxTurns → reason=max_turns + budgetExceededKind="max_turns"', async () => {
    const responses = Array.from({ length: 10 }, (_, i) => ({
      toolCalls: [{ id: `t${i}`, name: "read", input: {} }],
    }));
    const provider = new MockLLMProvider(responses);
    const opts = { ...makeBaseOpts(provider, [makeReadOnlyTool("read")]), maxTurns: 3 };

    const result = await runSubAgentLoop(opts);

    expect(result.reason).toBe("max_turns");
    expect(result.budgetExceededKind).toBe("max_turns");
    expect(result.toolUseCount).toBeGreaterThanOrEqual(3);
  });
});

// ─── error ───

describe("runSubAgentLoop · error path", () => {
  it("provider 第一次 chat 流式 error → reason=error,函数本身不 throw,error 字段透传 AgentError(type+message)", async () => {
    const provider = new MockLLMProvider([
      { error: new Error("upstream connection refused") },
    ]);

    const result = await runSubAgentLoop(makeBaseOpts(provider));

    expect(result.reason).toBe("error");
    expect(result.budgetExceededKind).toBeUndefined();
    expect(result.abortReason).toBeUndefined();
    // Layer 1 透传契约:reason="error" 时 error 字段含 AgentError 结构化字段。
    // llm-call.ts 把 LLM stream Error 包成 AgentError(type="provider_error"),
    // loop-runner 透传 type + message,让上层 factory.deriveErrorMeta 拿到真实
    // 诊断信息(而非"agent_error"占位)。
    expect(result.error).toBeDefined();
    expect(result.error?.type).toBe("provider_error");
    expect(result.error?.message).toContain("upstream connection refused");
  });

  it("非 error 路径(completed)error 字段为 undefined(只有 reason=error 时透传)", async () => {
    const provider = new MockLLMProvider([{ text: "task done" }]);
    const result = await runSubAgentLoop(makeBaseOpts(provider));
    expect(result.reason).toBe("completed");
    expect(result.error).toBeUndefined();
  });
});

// ─── parent abort ───

describe("runSubAgentLoop · parent abort cascade", () => {
  it("parentSignal pre-aborted → reason=aborted + abortReason.kind=parent-abort + budgetExceededKind=undefined", async () => {
    const provider = new MockLLMProvider([{ text: "should not reach" }]);
    const parentController = new AbortController();
    parentController.abort();

    const result = await runSubAgentLoop({
      ...makeBaseOpts(provider),
      parentSignal: parentController.signal,
    });

    expect(result.reason).toBe("aborted");
    expect(result.abortReason?.kind).toBe("parent-abort");
    // parent abort 不是软上限触发,kind 必须 undefined,classifier 才会折成 "aborted"
    // 而非 "failed"(否则就把"用户主动取消"误判为"资源耗尽",语义错位)
    expect(result.budgetExceededKind).toBeUndefined();
  });
});

// ─── max_tokens 软上限触发 ───

describe("runSubAgentLoop · max_tokens budget", () => {
  it('单次 LLM call 即超阈 → reason=aborted + budgetExceededKind="max_tokens" + abortReason.origin', async () => {
    // 第一次返回 usage 250 tokens > maxTokens=200 → listener 立即 abort
    // 第二次响应不应被消耗(loop 在下一轮顶 abort guard 停)
    const provider = new MockLLMProvider([
      {
        text: "first response",
        usage: { inputTokens: 150, outputTokens: 100 },
      },
      { text: "should not be consumed" },
    ]);

    const result = await runSubAgentLoop({
      ...makeBaseOpts(provider),
      maxTokens: 200,
    });

    expect(result.reason).toBe("aborted");
    expect(result.budgetExceededKind).toBe("max_tokens");
    expect(result.abortReason?.kind).toBe("external");
    if (result.abortReason?.kind === "external") {
      expect(result.abortReason.origin).toBe("subagent-max-tokens-exceeded");
    }
    // 关键:graceful 不 mid-call kill,第一次响应已完整 finalize,第二次未发起
    expect(provider.callCount).toBe(1);
  });

  it("多次 LLM call 累加才超阈 → 在累计超阈那一轮后停,partial 文本可抓", async () => {
    // 三次 turn,每次 100 tokens → 第三次后累计 300 > maxTokens=250
    const provider = new MockLLMProvider([
      {
        toolCalls: [{ id: "t1", name: "read", input: {} }],
        usage: { inputTokens: 60, outputTokens: 40 },
      },
      {
        toolCalls: [{ id: "t2", name: "read", input: {} }],
        usage: { inputTokens: 60, outputTokens: 40 },
      },
      {
        text: "partial assistant text",
        usage: { inputTokens: 60, outputTokens: 40 },
      },
      { text: "should not be consumed" },
    ]);

    const result = await runSubAgentLoop({
      ...makeBaseOpts(provider, [makeReadOnlyTool("read")]),
      maxTokens: 250,
    });

    expect(result.reason).toBe("aborted");
    expect(result.budgetExceededKind).toBe("max_tokens");
    expect(provider.callCount).toBe(3);
    // 累计 usage 应反映已发出的 3 次 call(loop 透传 AgentResult.usage)
    expect(result.usage.inputTokens + result.usage.outputTokens).toBeGreaterThanOrEqual(300);
    // partial assistant 文本已 finalize 进 messages —— 上层 extractFinalAssistantText 可抓
    const lastAssistant = result.messages
      .filter((m) => m.role === "assistant")
      .pop();
    expect(lastAssistant).toBeDefined();
  });

  it("usage 内 cacheRead/Write 不计入 budget —— 实际消耗 token 才算钱", async () => {
    // 即使 cache tokens 巨大,只要 input+output 不超阈,就不应触发
    const provider = new MockLLMProvider([
      {
        text: "cache hit cheap call",
        usage: {
          inputTokens: 50,
          outputTokens: 30,
          cacheReadTokens: 100_000,
          cacheWriteTokens: 50_000,
        },
      },
    ]);

    const result = await runSubAgentLoop({
      ...makeBaseOpts(provider),
      maxTokens: 200,
    });

    // input+output=80 < 200,不应触发,正常 completed
    expect(result.reason).toBe("completed");
    expect(result.budgetExceededKind).toBeUndefined();
  });

  it("maxTokens 设极大值 → 正常 completed 路径 budgetExceededKind=undefined", async () => {
    const provider = new MockLLMProvider([
      {
        text: "small reply",
        usage: { inputTokens: 50, outputTokens: 30 },
      },
    ]);

    const result = await runSubAgentLoop({
      ...makeBaseOpts(provider),
      maxTokens: 1_000_000,
    });

    expect(result.reason).toBe("completed");
    expect(result.budgetExceededKind).toBeUndefined();
    expect(result.abortReason).toBeUndefined();
  });
});

// ─── context_overflow 软上限触发 ───

describe("runSubAgentLoop · context_overflow 软上限触发", () => {
  it("单次 inputTokens 超 riskMaxTokens → graceful abort + budgetExceededKind", async () => {
    // 第一次 LLM call 单次 inputTokens=300 > riskMaxTokens=200 → 触发 abort
    // 第二次响应不应被消耗
    const provider = new MockLLMProvider([
      {
        text: "first call exceeds risk",
        usage: { inputTokens: 300, outputTokens: 10 },
      },
      { text: "should not be consumed" },
    ]);

    const result = await runSubAgentLoop({
      ...makeBaseOpts(provider),
      riskMaxTokens: 200,
    });

    expect(result.reason).toBe("aborted");
    expect(result.budgetExceededKind).toBe("context_overflow");
    expect(result.abortReason?.kind).toBe("external");
    if (result.abortReason?.kind === "external") {
      expect(result.abortReason.origin).toBe("subagent-context-overflow");
    }
    expect(provider.callCount).toBe(1);
  });

  it("累加超 maxTokens 但单次不超 riskMaxTokens → 触发 max_tokens 而非 context_overflow", async () => {
    // 三次 50+30=80 tokens,累计 240 超 maxTokens=200;但单次 inputTokens=50 < riskMaxTokens=10000
    const provider = new MockLLMProvider([
      {
        toolCalls: [{ id: "t1", name: "read", input: {} }],
        usage: { inputTokens: 50, outputTokens: 30 },
      },
      {
        toolCalls: [{ id: "t2", name: "read", input: {} }],
        usage: { inputTokens: 50, outputTokens: 30 },
      },
      {
        text: "third response",
        usage: { inputTokens: 50, outputTokens: 30 },
      },
      { text: "should not run" },
    ]);

    const result = await runSubAgentLoop({
      ...makeBaseOpts(provider, [makeReadOnlyTool("read")]),
      maxTokens: 200,
      riskMaxTokens: 10_000,
    });

    expect(result.reason).toBe("aborted");
    expect(result.budgetExceededKind).toBe("max_tokens");
  });

  it("first-wins:同次 call 同时超 max_tokens 与 riskMaxTokens 时 max_tokens 抢占槽位", async () => {
    // 单次 inputTokens=500 超 riskMaxTokens=300;同次累加 input+output=600 也超 maxTokens=400
    // listener 检查顺序:先 max_tokens 累加判断,后 context_overflow 单次判断
    // 二者同次满足 → max_tokens 先入槽 → first-wins 维持 max_tokens
    const provider = new MockLLMProvider([
      {
        text: "both exceed",
        usage: { inputTokens: 500, outputTokens: 100 },
      },
      { text: "should not run" },
    ]);

    const result = await runSubAgentLoop({
      ...makeBaseOpts(provider),
      maxTokens: 400,
      riskMaxTokens: 300,
    });

    expect(result.reason).toBe("aborted");
    expect(result.budgetExceededKind).toBe("max_tokens");
  });

  it("riskMaxTokens 设极大值 → 不触发,正常 completed", async () => {
    const provider = new MockLLMProvider([
      { text: "ok", usage: { inputTokens: 100, outputTokens: 50 } },
    ]);

    const result = await runSubAgentLoop({
      ...makeBaseOpts(provider),
      riskMaxTokens: 10_000_000,
    });

    expect(result.reason).toBe("completed");
    expect(result.budgetExceededKind).toBeUndefined();
  });

  it("usage 内 cacheRead/Write 不影响 context_overflow 判定 —— 只看真实 inputTokens", async () => {
    // inputTokens=100 < riskMaxTokens=200;cacheReadTokens 巨大也不应触发
    const provider = new MockLLMProvider([
      {
        text: "cache heavy but real input small",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 500_000,
          cacheWriteTokens: 100_000,
        },
      },
    ]);

    const result = await runSubAgentLoop({
      ...makeBaseOpts(provider),
      riskMaxTokens: 200,
    });

    expect(result.reason).toBe("completed");
    expect(result.budgetExceededKind).toBeUndefined();
  });
});

// ─── listener cleanup discipline ───

describe("runSubAgentLoop · listener cleanup", () => {
  it("happy path 完成后 eventBus 上 llm:request_end listener 被解绑", async () => {
    const provider = new MockLLMProvider([{ text: "ok" }]);
    const opts = makeBaseOpts(provider);

    const before = opts.eventBus.listenerCount("llm:request_end");
    await runSubAgentLoop(opts);
    const after = opts.eventBus.listenerCount("llm:request_end");

    // before/after 必须严格相等 —— loop-runner 自己的 listener 来去对称,
    // 不增不减,否则跨 dispatch 累积会让旧 dispatch 的 cumulativeTokens
    // 状态污染下次 dispatch 的 budget 判断
    expect(after).toBe(before);
  });

  it("max_tokens 触发后 listener 同样被解绑(异常路径不漏清理)", async () => {
    const provider = new MockLLMProvider([
      {
        text: "first",
        usage: { inputTokens: 150, outputTokens: 100 },
      },
    ]);
    const opts = { ...makeBaseOpts(provider), maxTokens: 200 };

    const before = opts.eventBus.listenerCount("llm:request_end");
    await runSubAgentLoop(opts);
    const after = opts.eventBus.listenerCount("llm:request_end");

    expect(after).toBe(before);
  });

  it("error path(provider 抛错)后 listener 同样被解绑", async () => {
    const provider = new MockLLMProvider([
      { error: new Error("provider down") },
    ]);
    const opts = makeBaseOpts(provider);

    const before = opts.eventBus.listenerCount("llm:request_end");
    await runSubAgentLoop(opts);
    const after = opts.eventBus.listenerCount("llm:request_end");

    expect(after).toBe(before);
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

// ─── wallClock 真触发(契约:折成 failed 而非 aborted) ───

describe("runSubAgentLoop · wall-clock 真触发折叠", () => {
  it('慢 LLM + wallClock 提前触发 → reason=aborted + budgetExceededKind="wall_clock" + abortReason.origin', async () => {
    // 慢 chat:第一次 LLM 内 await 100ms,wallClockTimeoutMs=20ms 在 sleep 中触发
    // wrapStreamWithAbortRace 会 race 到 abort,LLM call 立即退出 → reason=aborted
    // 这是 wallClock contract 的端到端验证 —— 上层 classifier 据此折成 failed
    const slowProvider = Object.assign(new MockLLMProvider([]), {
      chat: async function* () {
        await new Promise<void>((r) => setTimeout(r, 100));
        yield { type: "message_start" as const };
        yield {
          type: "message_end" as const,
          stopReason: "end_turn" as const,
          usage: { inputTokens: 50, outputTokens: 30 },
        };
      },
    });

    const result = await runSubAgentLoop({
      ...makeBaseOpts(slowProvider as unknown as MockLLMProvider),
      wallClockTimeoutMs: 20,
    });

    expect(result.reason).toBe("aborted");
    expect(result.budgetExceededKind).toBe("wall_clock");
    expect(result.abortReason?.kind).toBe("external");
    if (result.abortReason?.kind === "external") {
      expect(result.abortReason.origin).toBe("subagent-wall-clock-timeout");
    }
  }, 5000);
});

// ─── first-wins 真值表(白盒纯函数测试) ───
//
// 集成场景下 wallClock fire 与 listener emit usage 同时发生的物理 race 极罕见
// (stream race abort 让 emit usage 接近 0,timing 窗口窄到 ms 内),用纯函数真值表
// 锁住"槽位 first-wins + reason="max_turns" 优先于槽位"两条契约,比集成测试更可靠。

describe("deriveBudgetExceededKind · 真值表(纯函数 first-wins 折叠契约)", () => {
  it('reason="completed" + 槽位 null → undefined(正常 happy 路径)', () => {
    expect(deriveBudgetExceededKind("completed", null)).toBeUndefined();
  });

  it('reason="error" + 槽位 null → undefined(LLM/tool 异常路径)', () => {
    expect(deriveBudgetExceededKind("error", null)).toBeUndefined();
  });

  it('reason="aborted" + 槽位 null → undefined(parent-abort / idle-timeout 真正的中断)', () => {
    expect(deriveBudgetExceededKind("aborted", null)).toBeUndefined();
  });

  it('reason="max_turns" + 槽位 null → "max_turns"(loop 内置 reason 直给)', () => {
    expect(deriveBudgetExceededKind("max_turns", null)).toBe("max_turns");
  });

  it('reason="aborted" + 槽位="max_tokens" → "max_tokens"(token 抢占)', () => {
    expect(deriveBudgetExceededKind("aborted", "max_tokens")).toBe("max_tokens");
  });

  it('reason="aborted" + 槽位="wall_clock" → "wall_clock"(wallClock 抢占)', () => {
    expect(deriveBudgetExceededKind("aborted", "wall_clock")).toBe("wall_clock");
  });

  it('reason="max_turns" + 槽位="max_tokens" → "max_turns"(reason 优先于槽位 —— max_turns 不走 abort 通道,语义上 loop 内置 reason 是最权威的触发源)', () => {
    expect(deriveBudgetExceededKind("max_turns", "max_tokens")).toBe("max_turns");
  });

  it('reason="max_turns" + 槽位="wall_clock" → "max_turns"(同上,reason 优先)', () => {
    expect(deriveBudgetExceededKind("max_turns", "wall_clock")).toBe("max_turns");
  });

  it('reason="completed" + 槽位 非 null → undefined(异常组合,理论上 abort 一旦触发 reason 不可能 completed,但纯函数对此鲁棒返回 undefined)', () => {
    // 防御性测试:即使输入组合在生产中不可能,函数行为也确定 —— 不返回 budget kind
    // (因 reason 不是 aborted/max_turns,折叠规则不命中槽位通道)
    expect(deriveBudgetExceededKind("completed", "max_tokens")).toBeUndefined();
    expect(deriveBudgetExceededKind("completed", "wall_clock")).toBeUndefined();
  });

  it('reason="aborted" + 槽位="context_overflow" → "context_overflow"(质量类软上限触发)', () => {
    expect(deriveBudgetExceededKind("aborted", "context_overflow")).toBe(
      "context_overflow",
    );
  });

  it('reason="max_turns" + 槽位="context_overflow" → "max_turns"(reason 优先)', () => {
    expect(deriveBudgetExceededKind("max_turns", "context_overflow")).toBe(
      "max_turns",
    );
  });
});

// ─── first-wins 端到端验证(真集成,非纯函数白盒) ───
//
// 锁住"短 wallClockTimeoutMs + token 先 fire → 槽位 first-wins kind=max_tokens"场景
// (旧静态优先级实现也碰巧返回 max_tokens,但这里多一层 abortReason.origin 锁,
// 验证 abort signal first-wins 与 budgetExceededKind first-wins 同源)。

describe("runSubAgentLoop · first-wins 端到端", () => {
  it('token 先 fire(同 LLM call 即超阈)+ wallClockTimeoutMs 极短(20ms 也来不及)→ kind="max_tokens" + abortReason.origin="subagent-max-tokens-exceeded"', async () => {
    // LLM 同步完成 stream(无 sleep),emit "llm:request_end" 时 listener 即触发 abort,
    // wallClock 20ms setTimeout 还没轮到 fire(整个 LLM call < 几 ms)。
    // 验证 token 与 wallClock 两路独立 controller 共存,抢占顺序由 first-wins 决定。
    const provider = new MockLLMProvider([
      {
        text: "completed in one shot",
        usage: { inputTokens: 150, outputTokens: 100 },
      },
    ]);

    const result = await runSubAgentLoop({
      ...makeBaseOpts(provider),
      maxTokens: 100,
      wallClockTimeoutMs: 20,
    });

    expect(result.reason).toBe("aborted");
    expect(result.budgetExceededKind).toBe("max_tokens");
    expect(result.abortReason?.kind).toBe("external");
    if (result.abortReason?.kind === "external") {
      // abort signal first-wins 与 budgetExceededKind first-wins 同源同向 ——
      // 两路语义对齐(单一 first-wins 槽位的核心收益)
      expect(result.abortReason.origin).toBe("subagent-max-tokens-exceeded");
    }
  });
});
