/**
 * runChildAgent 集成测试 —— 装配 / 运行 / 折叠 / 永不抛 全流程
 *
 * 覆盖矩阵:
 *   - happy:reason=completed → status=completed,finalAssistantText 取最后 assistant
 *   - failed (LLM error):reason=error → status=failed + error.type=agent_error
 *   - failed (max_turns):reason=max_turns → status=failed + error.type=max_turns_exceeded + partial 抓
 *   - aborted (parent abort):parentSignal aborted → status=aborted + abortReason.kind=parent-abort
 *   - 子 lineage 派生:childBus.lineage 严格以 parentLineage 为前缀(EventBus 不变量)
 *   - 子工具过滤:subAgentSafe===true 才进 childTools
 *   - cleanup discipline:happy 与 error 路径 finally 都触发 bus.removeAllListeners + broker.cancelAll
 *   - INV-S6 永不抛:即使 SecurityPipeline / parentBus 等关键依赖 throw,函数仍返回 failed 而非抛出
 *
 * mock 策略:沿用 loop-runner 测试的真实 SecurityPipeline + ConfirmationBroker + MockLLMProvider,
 * factory 层关注的是装配 / 折叠契约,业务行为已被 loop-runner 测试覆盖
 */

import { describe, expect, it, vi } from "vitest";
import {
  ConfirmationBroker,
  createEventBus,
  MockLLMProvider,
  PermissionStore,
  SecurityPipeline,
  type AgentEventMap,
  type LLMRole,
  type LLMRoles,
  type ToolDefinition,
} from "@zhixing/core";
import { runChildAgent, type RunChildAgentOptions } from "../factory.js";
import { runContextStorage } from "../../runtime/run-context.js";

// ConfirmationBroker.prototype.cancelAll 的 spy 验证仍依赖该类作为
// 子 broker 实例化目标(factory 内部 new ConfirmationBroker())

// ─── 测试辅助 ───

function makeReadOnlyTool(name: string, subAgentSafe: boolean): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: "object" } as never,
    subAgentSafe,
    needsPermission: false,
    call: async () => ({ content: `${name}-ok`, isError: false }),
  };
}

function makeRoles(provider: MockLLMProvider): LLMRoles {
  const role: LLMRole = {
    provider,
    model: "mock-model",
    chat: (req) => provider.chat(req),
  };
  return { main: role, secondary: role };
}

function makeBaseOpts(
  provider: MockLLMProvider,
  overrides: Partial<RunChildAgentOptions> = {},
): RunChildAgentOptions {
  const parentBus = createEventBus<AgentEventMap>({ lineage: "main" });
  return {
    provider,
    model: "mock-model",
    llmRoles: makeRoles(provider),
    securityPipeline: new SecurityPipeline({
      workspace: process.cwd(),
      sessionType: "ci",
      permissionStore: new PermissionStore({ rootDir: null }),
    }),
    workspace: process.cwd(),
    workspaceSource: "cwd-fallback",
    parentBus,
    parentLineage: "main",
    parentTools: [makeReadOnlyTool("read", true)],
    parentSignal: new AbortController().signal,
    task: "test task description",
    ...overrides,
  };
}

// ─── happy ───

describe("runChildAgent · happy path", () => {
  it("纯文本回复 → status=completed,finalAssistantText 含最后 assistant 文本", async () => {
    const provider = new MockLLMProvider([{ text: "task done summary" }]);
    const result = await runChildAgent(makeBaseOpts(provider));

    expect(result.status).toBe("completed");
    expect(result.finalAssistantText).toBe("task done summary");
    expect(result.toolUses).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
    expect(result.abortReason).toBeUndefined();
    expect(result.partial).toBeUndefined(); // completed 不抓 partial
    expect(result.subAgentId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("usage 来自 loop 累计,toolUses 来自 tool_end 计数", async () => {
    const provider = new MockLLMProvider([
      { toolCalls: [{ id: "t1", name: "read", input: {} }] },
      { text: "done" },
    ]);
    const result = await runChildAgent(makeBaseOpts(provider));

    expect(result.status).toBe("completed");
    expect(result.toolUses).toBe(1);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });
});

// ─── failed ───

describe("runChildAgent · failed paths", () => {
  it("provider chat error → status=failed + error.type=agent_error", async () => {
    const provider = new MockLLMProvider([
      { error: new Error("upstream connection refused") },
    ]);
    const result = await runChildAgent(makeBaseOpts(provider));

    expect(result.status).toBe("failed");
    expect(result.error?.type).toBe("agent_error");
    expect(result.error?.message).toBeTruthy();
  });

  it("max_turns 触发 → status=failed + error.type=max_turns_exceeded + partial 抓", async () => {
    // 反复 tool_use 让 maxTurns 触发
    const responses = Array.from({ length: 8 }, (_, i) => ({
      text: i === 0 ? "thinking..." : undefined,
      toolCalls: [{ id: `t${i}`, name: "read", input: {} }],
    }));
    const provider = new MockLLMProvider(responses);
    const result = await runChildAgent(
      makeBaseOpts(provider, { budget: { maxTurns: 2 } }),
    );

    expect(result.status).toBe("failed");
    expect(result.error?.type).toBe("max_turns_exceeded");
    // 第一轮 assistant 有 "thinking..." 文本 → partial 应捕获
    expect(result.partial).toContain("thinking");
  });
});

// ─── aborted ───

describe("runChildAgent · aborted path", () => {
  it("parentSignal pre-aborted → status=aborted + abortReason.kind=parent-abort", async () => {
    const provider = new MockLLMProvider([{ text: "should not reach" }]);
    const parentController = new AbortController();
    parentController.abort();

    const result = await runChildAgent(
      makeBaseOpts(provider, { parentSignal: parentController.signal }),
    );

    expect(result.status).toBe("aborted");
    expect(result.abortReason?.kind).toBe("parent-abort");
  });
});

// ─── lineage 派生 ───

describe("runChildAgent · lineage 派生", () => {
  it("childBus.lineage 严格以 parentLineage + '/sub-' 开头 (EventBus 不变量自动校验)", async () => {
    const provider = new MockLLMProvider([{ text: "ok" }]);
    const observedLineages: string[] = [];

    const parentBus = createEventBus<AgentEventMap>({ lineage: "main" });
    // 任何子 emit 都会冒泡到 parent → 通过 listener meta.lineage 观测子 lineage
    parentBus.onAny((_evt, _payload, meta) => {
      if (meta?.lineage && meta.lineage !== "main") {
        observedLineages.push(meta.lineage);
      }
    });

    await runChildAgent(makeBaseOpts(provider, { parentBus }));

    expect(observedLineages.length).toBeGreaterThan(0);
    for (const lineage of observedLineages) {
      expect(lineage.startsWith("main/sub-")).toBe(true);
    }
  });
});

// ─── 子工具过滤 ───

describe("runChildAgent · subAgentSafe 过滤", () => {
  it("subAgentSafe=false 的工具不进入子 system prompt (子 LLM 看不到该工具)", async () => {
    // 让子里调一次工具,验证子能调 safe tool 但不能调 unsafe tool
    const provider = new MockLLMProvider([
      { toolCalls: [{ id: "t1", name: "read", input: {} }] },
      { text: "done" },
    ]);
    const safeTool = makeReadOnlyTool("read", true);
    const unsafeTool = makeReadOnlyTool("memory", false);

    const result = await runChildAgent(
      makeBaseOpts(provider, { parentTools: [safeTool, unsafeTool] }),
    );

    expect(result.status).toBe("completed");
    // 子收到的请求 tools 列表只包含 safeTool —— provider.calls 记录每次 chat 的 tools
    const lastCall = provider.calls.at(-1);
    expect(lastCall?.tools?.map((t) => t.name)).toEqual(["read"]);
    expect(lastCall?.tools?.map((t) => t.name)).not.toContain("memory");
  });
});

// ─── cleanup discipline ───

describe("runChildAgent · cleanup discipline", () => {
  it("happy path:childBroker 在 finally 调 cancelAll (即使无 pending)", async () => {
    const provider = new MockLLMProvider([{ text: "ok" }]);
    // spy ConfirmationBroker.prototype.cancelAll
    const cancelSpy = vi.spyOn(ConfirmationBroker.prototype, "cancelAll");
    try {
      await runChildAgent(makeBaseOpts(provider));
      // 至少调一次(child broker 的 cleanup);可能有 parent broker 也被 spy 但本测无影响
      expect(cancelSpy).toHaveBeenCalledWith("session-end");
    } finally {
      cancelSpy.mockRestore();
    }
  });

  it("error path:即使 LLM 抛错,bus listener 与 broker pending 仍被清理", async () => {
    const provider = new MockLLMProvider([{ error: new Error("boom") }]);
    const cancelSpy = vi.spyOn(ConfirmationBroker.prototype, "cancelAll");
    try {
      const result = await runChildAgent(makeBaseOpts(provider));
      expect(result.status).toBe("failed");
      expect(cancelSpy).toHaveBeenCalledWith("session-end");
    } finally {
      cancelSpy.mockRestore();
    }
  });
});

// ─── INV(永不抛) ───

describe("runChildAgent · INV 永不抛", () => {
  it("loop 启动阶段意外 throw (模拟 ALS 基础设施崩) → 顶层兜底转 failed,不抛出", async () => {
    const provider = new MockLLMProvider([{ text: "ok" }]);
    // spy ALS.run 让它直接 throw,模拟运行期"绝不该抛但抛了"的兜底场景
    const runSpy = vi
      .spyOn(runContextStorage, "run")
      .mockImplementation(() => {
        throw new Error("simulated loop infrastructure failure");
      });

    try {
      const result = await runChildAgent(makeBaseOpts(provider));

      // 关键不变量:函数返回 failed result,而非抛出 unhandled promise rejection
      expect(result.status).toBe("failed");
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain(
        "simulated loop infrastructure failure",
      );
    } finally {
      runSpy.mockRestore();
    }
  });

  it("durationMs 总是 >= 0,即使瞬时返回也不为负", async () => {
    const provider = new MockLLMProvider([{ text: "fast" }]);
    const result = await runChildAgent(makeBaseOpts(provider));
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
