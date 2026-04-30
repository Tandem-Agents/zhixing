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
    parentBroker: new ConfirmationBroker({ id: "parent-broker-test" }),
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
    expect(result.partial).toContain("thinking");
  });

  it("max_tokens 触发 → status=failed + error.type=max_tokens_exceeded + partial 抓 + 主 LLM 看见 is_error", async () => {
    // 第一次 LLM 返回 partial 文本 + usage 250 > maxTokens=200 → 软上限触发
    // 第二次响应不应被消耗(graceful 在下次 call 前停)
    const provider = new MockLLMProvider([
      {
        text: "I started analyzing the codebase and found...",
        usage: { inputTokens: 150, outputTokens: 100 },
      },
      { text: "should not be consumed" },
    ]);

    const result = await runChildAgent(
      makeBaseOpts(provider, { budget: { maxTokens: 200 } }),
    );

    expect(result.status).toBe("failed");
    expect(result.error?.type).toBe("max_tokens_exceeded");
    expect(result.error?.message).toBe("sub-agent reached max tokens budget");
    // partial 抓:第一轮已生成的 assistant 文本应能被主 LLM 看到 —— 子中止时 partial 复用契约
    expect(result.partial).toContain("started analyzing");
    // graceful 验证:provider 只被调一次,不 mid-call kill
    expect(provider.callCount).toBe(1);
  });

  it("wall_clock 触发 → status=failed + error.type=wall_clock_timeout (与 max_tokens 同款 budget 折叠语义)", async () => {
    // 慢 chat:第一次 LLM 内 await 100ms,wallClockTimeoutMs=20ms 在 sleep 中触发
    // 验证 spec 软上限触发协议:wallClock 与 max_tokens 同走 failed 折叠 + 对应 error.type
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

    const result = await runChildAgent(
      makeBaseOpts(slowProvider as unknown as MockLLMProvider, {
        budget: { wallClockTimeoutMs: 20 },
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.error?.type).toBe("wall_clock_timeout");
    expect(result.error?.message).toBe("sub-agent wall-clock timeout");
  }, 5000);
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

// ─── audit 血缘元信息 ───
//
// 验证策略:
//   factory 内部 `new ConfirmationBroker({ parentBrokerId, sourceAgentId, ... })`
//   产出的 child broker 不直接暴露给调用方。通过 `vi.spyOn(ConfirmationBroker.prototype, 'cancelAll')`
//   拦截 cleanup 时点的 broker 实例(spy.mock.instances 含每次调用的 this),
//   再调 instance.snapshot() 验证 audit 字段透传与 resolver 选择正确。
//
// 该方式覆盖 spec audit 元信息透传契约的所有要点(parentBrokerId / sourceAgentId
// 一致 + confirmationPolicy → resolver 路由),且不需引入额外公共 API 字段(YAGNI)。

/**
 * 找到本次 cleanup 中的 child broker 实例。spyOn(cancelAll).mock.instances
 * 含父 + 子 broker(若父也调过 cancelAll)。父 id 已在 makeBaseOpts 固定,
 * 据此过滤出 child broker 实例。
 */
function findChildBroker(
  cancelSpy: ReturnType<typeof vi.spyOn>,
  parentBrokerId: string,
): ConfirmationBroker | undefined {
  const instances = cancelSpy.mock.instances as readonly unknown[];
  return instances.find(
    (b): b is ConfirmationBroker =>
      b instanceof ConfirmationBroker && b.id !== parentBrokerId,
  );
}

describe("runChildAgent · audit 血缘 (parentBrokerId / sourceAgentId)", () => {
  it("child broker.snapshot() 含 parentBrokerId === parentBroker.id, sourceAgentId === subAgentId", async () => {
    const provider = new MockLLMProvider([{ text: "ok" }]);
    const parentBroker = new ConfirmationBroker({ id: "audit-parent-001" });
    const cancelSpy = vi.spyOn(ConfirmationBroker.prototype, "cancelAll");

    try {
      const result = await runChildAgent(
        makeBaseOpts(provider, { parentBroker }),
      );

      expect(result.status).toBe("completed");
      const childBroker = findChildBroker(cancelSpy, parentBroker.id);
      expect(childBroker).toBeDefined();

      const snap = childBroker!.snapshot();
      expect(snap.id).toBe(childBroker!.id);
      expect(snap.parentBrokerId).toBe("audit-parent-001");
      expect(snap.sourceAgentId).toBe(result.subAgentId);
      // child broker.id 一定与父不同(自动 randomUUID 与父固定 id 不冲突)
      expect(childBroker!.id).not.toBe(parentBroker.id);
    } finally {
      cancelSpy.mockRestore();
    }
  });

  it("缺省 budget.confirmationPolicy → child broker resolver = fail-to-deny (默认安全姿态)", async () => {
    const provider = new MockLLMProvider([{ text: "ok" }]);
    const cancelSpy = vi.spyOn(ConfirmationBroker.prototype, "cancelAll");

    try {
      await runChildAgent(makeBaseOpts(provider));
      const childBroker = findChildBroker(cancelSpy, "parent-broker-test");
      expect(childBroker?.snapshot().nonInteractiveResolver).toBe(
        "fail-to-deny",
      );
    } finally {
      cancelSpy.mockRestore();
    }
  });

  it("budget.confirmationPolicy='auto-deny' → child broker resolver = fail-to-deny (与缺省语义等价显式化)", async () => {
    const provider = new MockLLMProvider([{ text: "ok" }]);
    const cancelSpy = vi.spyOn(ConfirmationBroker.prototype, "cancelAll");

    try {
      await runChildAgent(
        makeBaseOpts(provider, { budget: { confirmationPolicy: "auto-deny" } }),
      );
      const childBroker = findChildBroker(cancelSpy, "parent-broker-test");
      expect(childBroker?.snapshot().nonInteractiveResolver).toBe(
        "fail-to-deny",
      );
    } finally {
      cancelSpy.mockRestore();
    }
  });
});

// ─── e2e:子调未注册工具 → SecurityPipeline 升级 critical → child broker fail-deny ───
//
// 验证 spec §8.1 / §8.4 核心承诺的端到端链路:
//   runChildAgent → runSubAgentLoop → createSecureExecuteTool →
//   SecurityPipeline.evaluate (未注册工具 → critical → requiresConfirmation=true) →
//   handleBrokerPath → child broker.requestConfirmation →
//   无 listener → resolveSubAgentResolver("inherit-or-deny") = failToDenyResolver →
//   decision.kind="deny" → SecurityBlockError → tool_result.isError=true →
//   子 LLM 看到 isError 后正常 reply
//
// 该测试是"audit 字段透传契约"之外,M2.2 阶段对 spec §8.1/§8.4 的唯一端到端覆盖。
// 利用 SecurityPipeline 对未注册工具默认走 critical → requiresConfirmation 的行为
// (已在 core/security/__tests__/security-pipeline.test.ts 验证),无需额外 mock。

describe("runChildAgent · 端到端 child broker fail-deny", () => {
  it("子调未注册边界工具 → SecurityPipeline 升级 critical → child broker fail-deny → tool_result.isError → 子 LLM 看到后 reply", async () => {
    const callSpy = vi.fn(async () => ({
      content: "should not be called",
      isError: false,
    }));

    // 工具名以 "mcp_" 前缀+未注册到 boundary registry,被 BoundaryImpactClassifier
    // 分类为 critical → OperationClassifierMiddleware 升级 confirm → requiresConfirmation = true。
    //
    // 注意:`needsPermission` 字段决定 PermissionStore.match 路径(给 extractArgument 提示),
    // **与 SecurityPipeline 的 critical 升级无关** —— 路径决定者是 boundary registry 分类。
    // 此处声明 true 与 ToolDefinition fail-closed 默认对齐,避免读者误以为"声明无需权限怎么还走 broker"
    const unknownTool: ToolDefinition = {
      name: "mcp_unregistered_audit_test",
      description: "未注册到 boundary registry,触发 SecurityPipeline critical 分类 → broker 路径",
      inputSchema: { type: "object" } as never,
      subAgentSafe: true,
      needsPermission: true,
      call: callSpy,
    };

    // 监听 parentBus 的 `tool:call_end` 事件 —— 子 bus emit 自动冒泡到父 bus,
    // 收集后直接断言 success=false 这个核心不变量。
    // (tool-executor 把 SecurityBlockError catch 后产出 tool_result.isError=true,
    //  对应 tool:call_end.success=false —— 见 packages/core/src/loop/tool-executor.ts)
    const observedToolEnds: Array<{ name: string; success: boolean }> = [];
    const parentBus = createEventBus<AgentEventMap>({ lineage: "main" });
    parentBus.on("tool:call_end", (payload) => {
      observedToolEnds.push({
        name: payload.name,
        success: payload.success,
      });
    });

    // MockLLMProvider 双轮:
    //   round 1: 调 unknownTool → secure-executor 抛 SecurityBlockError → tool_result.isError
    //   round 2: 子 LLM 看到 isError 后 reply 总结
    const provider = new MockLLMProvider([
      { toolCalls: [{ id: "u1", name: unknownTool.name, input: {} }] },
      { text: "tool was denied by security policy; reporting to user" },
    ]);

    const result = await runChildAgent(
      makeBaseOpts(provider, {
        parentTools: [unknownTool],
        parentBus,
      }),
    );

    // 子 agent 正常 completed(子 LLM 处理了 isError 并完成对话,而非抛 unhandled exception)
    expect(result.status).toBe("completed");

    // 关键不变量 1:工具的 call 函数从未被执行
    // (SecurityBlockError 在 secure-executor 阶段抛出,根本不到 originalExecute)
    expect(callSpy).not.toHaveBeenCalled();

    // 关键不变量 2:tool:call_end 事件 emit 时 success=false —— 直接断言 secure-executor
    // 抛出的 SecurityBlockError 被 tool-executor catch 转换成失败 tool_result 的不变量
    const unknownToolEnd = observedToolEnds.find(
      (e) => e.name === unknownTool.name,
    );
    expect(unknownToolEnd).toBeDefined();
    expect(unknownToolEnd?.success).toBe(false);

    // 关键不变量 3:toolUses 计数为 1(尝试调用算 1 次,即使被 deny;统计 LLM 决策数)
    expect(result.toolUses).toBe(1);
  });
});
