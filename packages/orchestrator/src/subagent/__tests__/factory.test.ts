/**
 * runChildAgent 集成测试 —— 装配 / 运行 / 折叠 / 永不抛 全流程
 *
 * 覆盖矩阵:
 *   - happy:reason=completed → status=completed,finalAssistantText 取最后 assistant
 *   - failed (LLM error):reason=error → status=failed + error.type 透传真实 AgentErrorType
 *     (如 provider_error / context_overflow / rate_limit) + message 携带 AgentError.message
 *   - failed (max_turns):reason=max_turns → status=failed + error.type=max_turns_exceeded + partial 抓
 *   - aborted (parent abort):parentSignal aborted → status=aborted + abortReason.kind=parent-abort
 *   - 子 lineage 派生:childBus.lineage 严格以 parentLineage 为前缀(EventBus 不变量)
 *   - 子工具过滤:sub-agent profile.enabledTools 包含的工具名才进 childTools
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
import { runContextStorage, type RunContext } from "../../runtime/run-context.js";

// ConfirmationBroker.prototype.cancelAll 的 spy 验证仍依赖该类作为
// 子 broker 实例化目标(factory 内部 new ConfirmationBroker())

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

function makeRoles(provider: MockLLMProvider): LLMRoles {
  const role: LLMRole = {
    provider,
    model: "mock-model",
    chat: (req) => provider.chat(req),
  };
  return { main: role, light: role, power: role };
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
      trustContext: { kind: "workspace", dir: process.cwd() },
      sessionType: "ci",
      permissionStore: new PermissionStore({ rootDir: null }),
    }),
    workspace: process.cwd(),
    workspaceSource: "cwd-fallback",
    parentBus,
    parentLineage: "main",
    parentBroker: new ConfirmationBroker({ id: "parent-broker-test" }),
    parentTools: [makeReadOnlyTool("read")],
    parentSignal: new AbortController().signal,
    task: "test task description",
    // 默认大阈值,避免常规测试场景误触发 context_overflow;专项测试 override
    riskMaxTokens: 10_000_000,
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
  it("provider chat error → status=failed + error.type 透传真实 AgentErrorType (provider_error) + message 透传真实文本", async () => {
    const provider = new MockLLMProvider([
      { error: new Error("upstream connection refused") },
    ]);
    const result = await runChildAgent(makeBaseOpts(provider));

    expect(result.status).toBe("failed");
    // llm-call.ts 把 LLM stream error 包成 AgentError(type="provider_error"),
    // loop-runner 透传 result.error,factory.deriveErrorMeta 优先使用 → 主 LLM
    // 拿到真实 type 而非历史的 "agent_error" 占位。
    expect(result.error?.type).toBe("provider_error");
    // message 透传 AgentError.message,含 LLM 原始错误文本(便于主 LLM 决策)
    expect(result.error?.message).toContain("upstream connection refused");
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

  it("context_overflow 触发 → status=failed + error.type=sub_agent_context_overflow + 切片提示进 message", async () => {
    // 单次 inputTokens=500 > riskMaxTokens=200 → 触发 context_overflow
    // 主 LLM 通过 error.message 收到切片提示文本(Task 工具 failed 渲染会拼入 ToolResult)
    const provider = new MockLLMProvider([
      {
        text: "I attempted but the context is too large.",
        usage: { inputTokens: 500, outputTokens: 50 },
      },
      { text: "should not be consumed" },
    ]);

    const result = await runChildAgent(
      makeBaseOpts(provider, { riskMaxTokens: 200 }),
    );

    expect(result.status).toBe("failed");
    expect(result.error?.type).toBe("sub_agent_context_overflow");
    expect(result.error?.message).toContain("Split the task");
    // partial 文本仍可抓 —— 与其他 budget 触发同款 partial 复用契约
    expect(result.partial).toContain("attempted");
    expect(provider.callCount).toBe(1);
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

describe("runChildAgent · sub-agent profile.enabledTools 过滤", () => {
  it("不在 sub-agent profile.enabledTools 中的工具不进入子 system prompt", async () => {
    // 让子里调一次工具,验证子能调 enabled tool 但不能调未 enabled 的工具
    const provider = new MockLLMProvider([
      { toolCalls: [{ id: "t1", name: "read", input: {} }] },
      { text: "done" },
    ]);
    // sub-agent profile.enabledTools 含 read 不含 memory
    const enabledTool = makeReadOnlyTool("read");
    const disabledTool = makeReadOnlyTool("memory");

    const result = await runChildAgent(
      makeBaseOpts(provider, { parentTools: [enabledTool, disabledTool] }),
    );

    expect(result.status).toBe("completed");
    // 子收到的请求 tools 列表只包含 enabled tool —— provider.calls 记录每次 chat 的 tools
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

});

// ─── ALS 嵌套隔离 ───
//
// runChildAgent 内部包了一层 `runContextStorage.run({ bus: childBus, lineage })`,
// AsyncLocalStorage.run 的栈式语义保证内层退出后外层 store 恢复。这是 Node.js
// stdlib 自身契约,但产品级承诺仍需在 agent 边界显式锁住 —— 防止未来某次
// 重构误把 runChildAgent 的内层 run 改成 enterWith(永久替换 store)等错误用法,
// 让父 turn 后续工具调用拿到子 lineage,事件冒泡链路彻底错乱。

describe("runChildAgent · ALS 嵌套隔离", () => {
  it("外层主 store 在 runChildAgent 调用前后保持引用相同(内层 ALS 不污染外层)", async () => {
    const provider = new MockLLMProvider([{ text: "child done" }]);
    const parentBus = createEventBus<AgentEventMap>({ lineage: "main" });
    const mainContext: RunContext = { bus: parentBus, lineage: "main" };

    let beforeStore: RunContext | undefined;
    let afterStore: RunContext | undefined;

    await runContextStorage.run(mainContext, async () => {
      beforeStore = runContextStorage.getStore();
      // runChildAgent 内部 `runContextStorage.run({ bus: childBus, lineage: 'main/sub-...' })`
      // 临时替换 store,async callback 退出后栈自动恢复 mainContext
      await runChildAgent(makeBaseOpts(provider, { parentBus }));
      afterStore = runContextStorage.getStore();
    });

    // 外层 store 引用同一对象(嵌套 run 退出后栈恢复,非新建)
    expect(beforeStore).toBe(mainContext);
    expect(afterStore).toBe(mainContext);
    // lineage 仍是主路径,未被子的 main/sub-... 覆盖
    expect(beforeStore?.lineage).toBe("main");
    expect(afterStore?.lineage).toBe("main");
  });

  it("调 runChildAgent 多次,外层主 store 保持稳定(顺序调用栈对称)", async () => {
    const mainContext: RunContext = {
      bus: createEventBus<AgentEventMap>({ lineage: "main" }),
      lineage: "main",
    };

    const captured: Array<RunContext | undefined> = [];

    await runContextStorage.run(mainContext, async () => {
      for (let i = 0; i < 3; i++) {
        captured.push(runContextStorage.getStore());
        await runChildAgent(
          makeBaseOpts(new MockLLMProvider([{ text: `child ${i}` }]), {
            parentBus: mainContext.bus,
          }),
        );
        captured.push(runContextStorage.getStore());
      }
    });

    // 6 次取样全是同一外层 store 引用(任意一次失守即 ALS 嵌套机制崩坏)
    for (const store of captured) {
      expect(store).toBe(mainContext);
    }
  });
});
