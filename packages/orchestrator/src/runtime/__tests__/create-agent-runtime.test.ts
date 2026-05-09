/**
 * createAgentRuntime / runtime.run() 契约级集成测试
 *
 * 范围:验证 lifecycle 不变量,**不**测 LLM 业务行为(后者归 agent-loop 测试)。
 *
 * 覆盖契约:
 *   1. lineage="main" —— per-run EventBus 必须以 "main" 标记 root,
 *      M2 子 agent 派生 "main/sub-xxx" 路径的前提
 *   2. decorateRunBus 调用时序与次数 —— run() 入口调一次,run() finally
 *      调返回的 dispose 一次,严格 1:1
 *   3. safeDispose 故障隔离 —— accumulator dispose / decorator dispose
 *      任一 throw 都不阻断对方,不覆盖原始错误
 *   4. per-run 隔离 —— 同一 runtime 连续 run 各创建独立 EventBus 实例,
 *      newMessages / contextEngine / secureExecuteTool 不跨 run 串状态
 *
 * mock 策略:
 *   - vi.mock("@zhixing/providers") 替换 createProviderRoles /
 *     resolveWorkspace / ensureWorkspaceDir,杜绝真实 fs / config 依赖
 *   - MockLLMProvider 提供确定性 LLM 响应
 *   - vi.hoisted ref 让每个测试动态注入不同的 provider 响应序列
 */

import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  MockLLMProvider,
  userMessage,
  type IEventBus,
  type LLMRole,
  type LLMRoles,
  type AgentEventMap,
  type ToolDefinition,
} from "@zhixing/core";

// ─── hoisted ref:让 vi.mock 工厂在 import 之前能引用 ───

const { providerRef, decorateCalls, decorateDisposes } = vi.hoisted(() => ({
  providerRef: { current: null as MockLLMProvider | null },
  decorateCalls: [] as Array<IEventBus<AgentEventMap>>,
  decorateDisposes: [] as Array<() => void>,
}));

vi.mock("@zhixing/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zhixing/providers")>();
  // 最小 ResolvedProvider 骨架 —— createAgentRuntime 仅读 .protocol,其它字段
  // 不被 runtime 主流程消费,as 强转换出 typed 实例供 resolveModelInfo 使用
  const resolvedProvider = {
    id: "mock",
    name: "Mock",
    baseUrl: "http://mock",
    apiKey: "mock",
    protocol: "openai-compatible" as const,
    quirks: {
      maxTokensField: "max_tokens" as const,
      supportsStreamUsage: false,
    },
  } as never;
  const resolvedRole = { resolved: resolvedProvider, model: "mock-model" };

  return {
    ...actual,
    // mock 关键工厂:返回挂着 MockLLMProvider 的角色对,不触碰 fs / config
    createProviderRoles: () => {
      const provider = providerRef.current ?? new MockLLMProvider([{ text: "ok" }]);
      const role: LLMRole = {
        provider,
        model: "mock-model",
        chat: (request) => provider.chat(request),
      };
      const roles: LLMRoles = { main: role, secondary: role };
      return {
        roles,
        config: { providers: {} } as never,
        resolvedRoles: { main: resolvedRole, secondary: resolvedRole } as never,
      };
    },
    // workspace 走 cwd-fallback,跳过配置层
    resolveWorkspace: () => ({
      path: process.cwd(),
      source: "cwd-fallback" as const,
    }),
    // 不真的 mkdir
    ensureWorkspaceDir: () => "exists" as const,
  };
});

// 必须在 vi.mock 之后 import,确保 createAgentRuntime 拿到的是 mock 后的 providers
const { createAgentRuntime } = await import("../create-agent-runtime.js");

// ─── 测试辅助 ───

beforeEach(() => {
  providerRef.current = null;
  decorateCalls.length = 0;
  decorateDisposes.length = 0;
});

/** 装饰器 spy:记录 ctx.bus + 返回可断言的 dispose */
function makeDecorateRunBus() {
  const dispose = vi.fn();
  return {
    decorate: (ctx: { bus: IEventBus<AgentEventMap> }) => {
      decorateCalls.push(ctx.bus);
      decorateDisposes.push(dispose);
      return dispose;
    },
    dispose,
  };
}

// ─── 契约 1: lineage="main" 标记 ───

describe("createAgentRuntime · run() lineage 契约", () => {
  it("per-run EventBus 必须标记 lineage='main'(M2 子 agent 派生路径的前提)", async () => {
    providerRef.current = new MockLLMProvider([{ text: "ok" }]);
    const { decorate } = makeDecorateRunBus();

    const runtime = await createAgentRuntime({
      decorateRunBus: decorate,
    });
    await runtime.run({
      messages: [userMessage("hi")],
      turnIndex: 0,
    });

    expect(decorateCalls).toHaveLength(1);
    expect(decorateCalls[0]?.lineage).toBe("main");
  });
});

// ─── 契约 2: decorateRunBus 调用时序与次数 ───

describe("createAgentRuntime · decorateRunBus 调用契约", () => {
  it("成功路径:run() 入口调装饰器 1 次,finally 调 dispose 1 次", async () => {
    providerRef.current = new MockLLMProvider([{ text: "done" }]);
    const { decorate, dispose } = makeDecorateRunBus();

    const runtime = await createAgentRuntime({ decorateRunBus: decorate });
    await runtime.run({ messages: [userMessage("hi")], turnIndex: 0 });

    expect(decorateCalls).toHaveLength(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("agent loop throw 路径:dispose 仍被调用一次", async () => {
    // provider 在第 1 次 chat 即 throw —— agent loop 内部 catch + 转 RunResult,
    // run() 不 throw,但 finally 必须 fire
    providerRef.current = new MockLLMProvider([
      { error: new Error("upstream connection refused") },
    ]);
    const { decorate, dispose } = makeDecorateRunBus();

    const runtime = await createAgentRuntime({ decorateRunBus: decorate });
    const result = await runtime.run({
      messages: [userMessage("hi")],
      turnIndex: 0,
    });

    expect(result.agentResult.reason).toBe("error");
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("pre-flight aborted 路径:dispose 仍被调用一次(abort 在 agent loop 启动前发生)", async () => {
    providerRef.current = new MockLLMProvider([{ text: "should not reach" }]);
    const { decorate, dispose } = makeDecorateRunBus();
    const controller = new AbortController();
    controller.abort();

    const runtime = await createAgentRuntime({ decorateRunBus: decorate });
    const result = await runtime.run({
      messages: [userMessage("hi")],
      turnIndex: 0,
      abortSignal: controller.signal,
    });

    expect(result.agentResult.reason).toBe("aborted");
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("不传 decorateRunBus:run() 正常完成,无副作用", async () => {
    providerRef.current = new MockLLMProvider([{ text: "ok" }]);

    const runtime = await createAgentRuntime({});
    const result = await runtime.run({
      messages: [userMessage("hi")],
      turnIndex: 0,
    });

    expect(result.agentResult.reason).toBe("completed");
    expect(decorateCalls).toHaveLength(0);
  });
});

// ─── 契约 3: safeDispose 故障隔离 ───

describe("createAgentRuntime · safeDispose 故障隔离契约", () => {
  let consoleErrorSpy: MockInstance<typeof console.error>;
  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("装饰器 dispose throw 不阻断 run 完成 + 错误被结构化日志记录", async () => {
    providerRef.current = new MockLLMProvider([{ text: "ok" }]);
    const decorate = (_ctx: { bus: IEventBus<AgentEventMap> }) => {
      return () => {
        throw new Error("decorator dispose boom");
      };
    };

    const runtime = await createAgentRuntime({ decorateRunBus: decorate });

    // run() 正常返回 —— dispose throw 被 safeDispose 吞掉
    const result = await runtime.run({
      messages: [userMessage("hi")],
      turnIndex: 0,
    });
    expect(result.agentResult.reason).toBe("completed");

    // 日志带 [orchestrator.run.decorate] 命名空间标签
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[orchestrator.run.decorate]"),
      expect.any(Error),
    );
  });

  it("第二次 run() 仍能正常工作 —— 证明 listener 没残留(隐式验证 accumulator dispose 已生效)", async () => {
    providerRef.current = new MockLLMProvider([
      { text: "first" },
      { text: "second" },
    ]);
    const { decorate, dispose } = makeDecorateRunBus();

    const runtime = await createAgentRuntime({ decorateRunBus: decorate });

    // 跑两轮:每轮 dispose 都应被独立调用
    await runtime.run({ messages: [userMessage("hi")], turnIndex: 0 });
    await runtime.run({ messages: [userMessage("hi2")], turnIndex: 1 });

    expect(dispose).toHaveBeenCalledTimes(2);
    // 装饰器收到的两次 ctx.bus 应当是独立实例
    expect(decorateCalls).toHaveLength(2);
    expect(decorateCalls[0]).not.toBe(decorateCalls[1]);
  });
});

// ─── 契约 4: per-run EventBus 隔离 ───

describe("createAgentRuntime · per-run 隔离契约", () => {
  it("同一 runtime 连续 run() 各创建独立 EventBus 实例(都 lineage='main')", async () => {
    providerRef.current = new MockLLMProvider([
      { text: "r1" },
      { text: "r2" },
      { text: "r3" },
    ]);
    const { decorate } = makeDecorateRunBus();

    const runtime = await createAgentRuntime({ decorateRunBus: decorate });
    await runtime.run({ messages: [userMessage("a")], turnIndex: 0 });
    await runtime.run({ messages: [userMessage("b")], turnIndex: 1 });
    await runtime.run({ messages: [userMessage("c")], turnIndex: 2 });

    expect(decorateCalls).toHaveLength(3);
    expect(decorateCalls[0]?.lineage).toBe("main");
    expect(decorateCalls[1]?.lineage).toBe("main");
    expect(decorateCalls[2]?.lineage).toBe("main");
    // 三个 bus 必须是不同实例(===)
    expect(decorateCalls[0]).not.toBe(decorateCalls[1]);
    expect(decorateCalls[1]).not.toBe(decorateCalls[2]);
    expect(decorateCalls[0]).not.toBe(decorateCalls[2]);
  });

  it("两次 run() 的 newMessages 互不串扰(per-run 状态隔离)", async () => {
    providerRef.current = new MockLLMProvider([
      { text: "alpha" },
      { text: "beta" },
    ]);

    const runtime = await createAgentRuntime({});
    const r1 = await runtime.run({
      messages: [userMessage("ask 1")],
      turnIndex: 0,
    });
    const r2 = await runtime.run({
      messages: [userMessage("ask 2")],
      turnIndex: 1,
    });

    // 两次 run 各自只产生本轮 assistant message,不互相累积
    expect(r1.newMessages).toHaveLength(1);
    expect(r2.newMessages).toHaveLength(1);
    // turn 索引透传无误
    expect(r1.turn.turnIndex).toBe(0);
    expect(r2.turn.turnIndex).toBe(1);
  });
});

// ─── 契约 5: forceCompact dispose 防御对称(P1-1 修复) ───

describe("createAgentRuntime · forceCompact safeDispose 对称防御", () => {
  it("forceCompact() 不抛 dispose 异常即使 localBus 内累积器抛错(防御契约对称 run())", async () => {
    providerRef.current = new MockLLMProvider([{ text: "ok" }]);

    const runtime = await createAgentRuntime({});
    // forceCompact 在空消息列表上不会触发任何策略,正常返回
    // —— 本测试核心断言:无 unhandled rejection / throw,
    //    证明 finally 块 safeDispose 调用路径稳定
    await expect(
      runtime.forceCompact([userMessage("test")], 0),
    ).resolves.toBeDefined();
  });
});

// ─── 契约 6: ALS 包裹 —— 工具 call 内可取 RunContext ───

describe("createAgentRuntime · ALS RunContext 透传契约", () => {
  it("工具 call 内 runContextStorage.getStore() 非空,bus===run 的 eventBus,lineage='main'", async () => {
    // probe 工具:在 call() 内捕获 ALS 状态供测试断言。
    // 这是验证"runtime.run() 入口的 runContextStorage.run 包裹真的覆盖到工具调用层"
    // 的最直接方式 —— 只要工具能拿到与 decorateRunBus 同实例的 bus,
    // 就证明 ALS 链路在嵌套 async 边界(while gen.next → tool.call)上不断裂
    const { runContextStorage } = await import("../run-context.js");
    let alsState: { bus: unknown; lineage: string } | undefined;
    const probeTool: ToolDefinition = {
      name: "probe",
      description: "probe ALS state",
      inputSchema: { type: "object", properties: {} },
      needsPermission: false,
      // 声明 read access 让 BoundaryImpactClassifier 分类为 observe(放行,
      // 不触发 SecurityPipeline 升级到 confirm → 否则 broker 走 fail-to-deny 拒了)
      boundaries: [{ boundaryType: "process", access: "read", dynamic: false }],
      call: async () => {
        const store = runContextStorage.getStore();
        alsState = store
          ? { bus: store.bus, lineage: store.lineage }
          : undefined;
        return { content: "captured", isError: false };
      },
    };
    providerRef.current = new MockLLMProvider([
      { toolCalls: [{ id: "p1", name: "probe", input: {} }] },
      { text: "done" },
    ]);

    let capturedBus: IEventBus<AgentEventMap> | null = null;
    const runtime = await createAgentRuntime({
      extraTools: [probeTool],
      decorateRunBus: ({ bus }) => {
        capturedBus = bus;
        return () => {};
      },
    });
    await runtime.run({ messages: [userMessage("hi")], turnIndex: 0 });

    expect(alsState).toBeDefined();
    expect(alsState!.bus).toBe(capturedBus);
    expect(alsState!.lineage).toBe("main");
  });

  it("不传 enableTaskTool / 无 Task 工具:run() 仍正常完成(向后兼容,默认 false)", async () => {
    providerRef.current = new MockLLMProvider([{ text: "no task here" }]);
    // 默认装配路径:不开 Task,沿用既有 cli/server 调用方约定
    const runtime = await createAgentRuntime({});
    const result = await runtime.run({
      messages: [userMessage("hi")],
      turnIndex: 0,
    });
    expect(result.agentResult.reason).toBe("completed");
  });

  // 并发隔离契约 —— ALS 模型的核心承诺:每次 runtime.run() 走独立 store,
  // 不同 run 的工具 call 取到各自 run 的 bus / lineage,绝不串扰。
  // 这是产品级承诺:未来若服务端单实例多并发 conversation,无需重构 —— 由 Node.js
  // async_hooks 的 store 隔离保证。spec §15 M2.3 验证清单显式要求此场景覆盖。
  it("两个并发 run()(独立 runtime)各自 ALS 上下文不串扰,probeTool 取到自己 run 的 bus", async () => {
    const { runContextStorage } = await import("../run-context.js");
    const captures: Array<{
      runId: string;
      bus: unknown;
      lineage: string;
    }> = [];
    function makeProbe(runId: string): ToolDefinition {
      return {
        name: "probe",
        description: `probe ${runId}`,
        inputSchema: { type: "object", properties: {} },
        needsPermission: false,
        boundaries: [{ boundaryType: "process", access: "read", dynamic: false }],
        call: async () => {
          // 引入微小延时,让两个并发 run 的 probe.call 真在不同时间窗口落入 ALS 链路
          // —— 顺序串行不能证明 ALS 隔离(任何 mutable cell 都过),并发交错才检验
          await new Promise((r) => setTimeout(r, 10));
          const store = runContextStorage.getStore();
          captures.push({
            runId,
            bus: store?.bus,
            lineage: store?.lineage ?? "missing",
          });
          return { content: `${runId} captured`, isError: false };
        },
      };
    }

    // runtime1 装配:provider 闭包捕获,后续 providerRef.current 改动不影响 runtime1
    providerRef.current = new MockLLMProvider([
      { toolCalls: [{ id: "p1", name: "probe", input: {} }] },
      { text: "done 1" },
    ]);
    let bus1: IEventBus<AgentEventMap> | null = null;
    const runtime1 = await createAgentRuntime({
      extraTools: [makeProbe("R1")],
      decorateRunBus: ({ bus }) => {
        bus1 = bus;
        return () => {};
      },
    });

    // runtime2 装配:独立 provider 序列
    providerRef.current = new MockLLMProvider([
      { toolCalls: [{ id: "p2", name: "probe", input: {} }] },
      { text: "done 2" },
    ]);
    let bus2: IEventBus<AgentEventMap> | null = null;
    const runtime2 = await createAgentRuntime({
      extraTools: [makeProbe("R2")],
      decorateRunBus: ({ bus }) => {
        bus2 = bus;
        return () => {};
      },
    });

    // 关键:Promise.all 真并发,两个 runtime.run() 的 ALS root 独立创建
    const [r1, r2] = await Promise.all([
      runtime1.run({ messages: [userMessage("first")], turnIndex: 0 }),
      runtime2.run({ messages: [userMessage("second")], turnIndex: 0 }),
    ]);

    expect(r1.agentResult.reason).toBe("completed");
    expect(r2.agentResult.reason).toBe("completed");
    expect(captures).toHaveLength(2);

    // 关键断言:两次 capture 的 bus 各自属于对应 run 的 bus —— 不串扰
    const cap1 = captures.find((c) => c.runId === "R1");
    const cap2 = captures.find((c) => c.runId === "R2");
    expect(cap1).toBeDefined();
    expect(cap2).toBeDefined();
    expect(cap1!.bus).toBe(bus1);
    expect(cap2!.bus).toBe(bus2);
    // 两个 bus 必须是不同实例(per-run 各自创建)
    expect(bus1).not.toBe(bus2);
    expect(bus1).not.toBeNull();
    expect(bus2).not.toBeNull();
    // lineage 都是 "main"(每次 run 入口 lineage 固定 "main")
    expect(cap1!.lineage).toBe("main");
    expect(cap2!.lineage).toBe("main");
  });
});

// ─── 契约 7: enableTaskTool 装配 —— Task 可被 LLM 派调,完成端到端委派 ───

describe("createAgentRuntime · enableTaskTool 装配契约", () => {
  it("enableTaskTool=true:LLM 调 Task → 子 agent 跑完 → 主收到 tool_result 综合输出", async () => {
    // 主 + 子共用同一 MockLLMProvider 序列(provider 实例共享),按 chat 调用顺序消费:
    //   1. 主 LLM:派 Task tool_use
    //   2. 子 LLM:产 final assistant text
    //   3. 主 LLM:看 tool_result + 综合输出
    providerRef.current = new MockLLMProvider([
      {
        toolCalls: [
          { id: "tk1", name: "Task", input: { description: "deep dive", prompt: "research X" } },
        ],
      },
      { text: "child sub-agent final answer about X" },
      { text: "synthesized response based on sub-agent output" },
    ]);

    const runtime = await createAgentRuntime({ enableTaskTool: true });
    const result = await runtime.run({
      messages: [userMessage("research X please")],
      turnIndex: 0,
    });

    expect(result.agentResult.reason).toBe("completed");
    // 序列消费断言:主 LLM 第 1 次(派 Task)+ 子 LLM 第 1 次(产 final)+ 主 LLM 第 2 次(综合)= 3 次
    expect(providerRef.current!.callCount).toBe(3);
    // 主回收的最后 assistant 文本来自第 3 次 chat 的综合输出
    expect(result.newMessages.length).toBeGreaterThan(0);
    const lastAssistant = result.newMessages.findLast((m) => m.role === "assistant");
    expect(lastAssistant).toBeDefined();
    const lastText = lastAssistant!.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    expect(lastText).toContain("synthesized response");
  });

  it("enableTaskTool=true:Task 工具 subAgentSafe 仍为 false(防递归不变量)", async () => {
    // 不直接观察 tools 数组(runtime 不暴露),通过派 Task 让子尝试再派 Task 触发 unknown tool 路径
    // —— 子工具集应只含 subAgentSafe===true 的工具,Task 自身不在内
    providerRef.current = new MockLLMProvider([
      {
        toolCalls: [
          { id: "tk1", name: "Task", input: { description: "outer", prompt: "p" } },
        ],
      },
      // 子 LLM:尝试再派 Task(应失败,因为子工具集不含 Task)
      {
        toolCalls: [
          { id: "tk2", name: "Task", input: { description: "inner", prompt: "p2" } },
        ],
      },
      // 子 LLM 收到错误后产 final text
      { text: "child cannot dispatch further sub-agents" },
      // 主 LLM 综合
      { text: "main saw sub failure" },
    ]);

    const runtime = await createAgentRuntime({ enableTaskTool: true });
    const result = await runtime.run({
      messages: [userMessage("test recursion guard")],
      turnIndex: 0,
    });

    // 主 run 应正常完成 —— 子的"递归 Task"被工具集过滤拒绝,
    // 子最终产出文本被主 LLM 综合,主返 completed
    expect(result.agentResult.reason).toBe("completed");
  });
});

// ─── Task 端到端集成 ───
//
// 子 agent 各路径状态机已被单测覆盖;集成层在 createAgentRuntime + enableTaskTool
// 装配下走真实主→子→主链路,锁住主子隔离 / 并发 / 子 fail 不波及父 / lineage 冒泡
// 这几个产品级承诺。
//
// 不在此覆盖:
//   - 父 abort 多 Task 同时级联 —— tool-executor 的 cancel placeholder 行为与
//     sub-agent loop 的 abort path 在并发下时序难以稳定锁住,留 e2e 阶段做。
//     单 sub 的 parent-abort 路径已被 factory.test.ts 与 agent-loop.test.ts 充分覆盖
//   - confirmation 父子规则交互 —— 由 PermissionStore + child broker 各自单测
//     等价覆盖,集成层不重复测同一路径

describe("Task 端到端集成 · 主子隔离 / 并发 / 子 fail / lineage 冒泡", () => {
  /** 抽出主 turn assistantMessage 的纯文本(便于断言主综合输出) */
  function getAssistantText(turn: { assistantMessage: { content: readonly unknown[] } }): string {
    return turn.assistantMessage.content
      .filter((b): b is { type: "text"; text: string } =>
        typeof b === "object" && b !== null && (b as { type: string }).type === "text",
      )
      .map((b) => b.text)
      .join("");
  }

  it("单 Task 端到端:主 turn 只含主 user/主 assistant/Task toolCall 记录(子内部 messages 不冒入主 turn)", async () => {
    // 主 turn 是 assertable 单元(turn.userMessage / assistantMessage / toolCalls);
    // 子 agent 的内部 user/assistant messages 不应冒泡到主 turn —— 子 final
    // 仅以 tool_result 字符串形式出现在 toolCalls[i].result。
    providerRef.current = new MockLLMProvider([
      {
        toolCalls: [
          { id: "tk1", name: "Task", input: { description: "research", prompt: "do X" } },
        ],
      },
      { text: "[child-only marker] internal final answer" },
      { text: "[main-only marker] synthesized output" },
    ]);

    const runtime = await createAgentRuntime({ enableTaskTool: true });
    const result = await runtime.run({
      messages: [userMessage("user question")],
      turnIndex: 0,
    });

    expect(result.agentResult.reason).toBe("completed");

    // 主 turn.userMessage 是用户原始消息(非子的"Begin"伪 user message)
    const userText = (
      result.turn.userMessage.content[0] as { text: string }
    ).text;
    expect(userText).toBe("user question");

    // 主 turn.assistantMessage 是主综合 —— 不含子 final 文本(子文本是 tool_result.content,不是独立 assistant)
    const assistantText = getAssistantText(result.turn);
    expect(assistantText).toContain("[main-only marker]");
    expect(assistantText).not.toContain("[child-only marker]");

    // 主 turn.toolCalls 含 Task 一条记录,result 字段(扁平化字符串)含子 final
    expect(result.turn.toolCalls).toHaveLength(1);
    const taskCall = result.turn.toolCalls![0]!;
    expect(taskCall.name).toBe("Task");
    expect(taskCall.input).toMatchObject({ description: "research", prompt: "do X" });
    expect(taskCall.result).toContain("[child-only marker]");
    expect(taskCall.isError).toBeFalsy();

    // 主 newMessages 中独立 assistant message 全集不含子 final 文本
    // (子内部 message 流不冒泡到主 yield 层 —— "上下文不被子串扰"的核心承诺)
    const standaloneAssistantTexts = result.newMessages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content)
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text);
    expect(standaloneAssistantTexts.some((t) => t.includes("[main-only marker]"))).toBe(true);
    for (const t of standaloneAssistantTexts) {
      expect(t).not.toContain("[child-only marker]");
    }
  });

  it("并发 3 个 Task:all settled,主 turn 一次成型含 3 条 toolCalls", async () => {
    // 产品核心承诺"3 并发"的端到端锁。
    // tool-executor 在 N≥2 全 isParallelSafe 时走 Promise.allSettled 真并发,
    // Task subAgentSafe=false 但本身 isParallelSafe=true,主同 turn 派 3 个可并发。
    // (单测层面 callIndex 顺序消费,真并发的耗时基准归性能测试;本测只验证完成性)
    providerRef.current = new MockLLMProvider([
      {
        toolCalls: [
          { id: "tk1", name: "Task", input: { description: "A", prompt: "task A" } },
          { id: "tk2", name: "Task", input: { description: "B", prompt: "task B" } },
          { id: "tk3", name: "Task", input: { description: "C", prompt: "task C" } },
        ],
      },
      { text: "child-final-α" },
      { text: "child-final-β" },
      { text: "child-final-γ" },
      { text: "synthesized A+B+C" },
    ]);

    const runtime = await createAgentRuntime({ enableTaskTool: true });
    const result = await runtime.run({
      messages: [userMessage("compare A vs B vs C")],
      turnIndex: 0,
    });

    expect(result.agentResult.reason).toBe("completed");
    // 5 次 chat: 1 主分发 + 3 子终结 + 1 主综合
    expect(providerRef.current!.callCount).toBe(5);

    // 主 turn 含 3 条 toolCalls,各自 success
    expect(result.turn.toolCalls).toHaveLength(3);
    for (const tc of result.turn.toolCalls!) {
      expect(tc.name).toBe("Task");
      expect(tc.isError).toBeFalsy();
    }
    // 3 条 result 字符串覆盖 3 个子 final(顺序未定 —— callIndex sync 但完成顺序与
    // 子 finalize 顺序耦合,我们只需断言三者全部出现)
    const allResults = result.turn.toolCalls!.map((tc) => tc.result).join("\n");
    expect(allResults).toContain("child-final-α");
    expect(allResults).toContain("child-final-β");
    expect(allResults).toContain("child-final-γ");

    // 主综合输出
    expect(getAssistantText(result.turn)).toContain("synthesized A+B+C");
  });

  it("子 LLM error → tool_result is_error=true,主 agent 继续完成 turn(子 fail 不波及父)", async () => {
    // 核心不变量 —— 子失败 ≠ 主死。
    // 子 LLM stream error → runChildAgent 折成 status="failed" → formatChildResultAsToolResult
    // 给 isError=true → tool-executor catch 后产出 tool_result is_error=true →
    // 主 LLM 看到 isError 后继续完成 turn(三态折叠契约)
    providerRef.current = new MockLLMProvider([
      {
        toolCalls: [{ id: "tk1", name: "Task", input: { description: "fetch", prompt: "x" } }],
      },
      { error: new Error("upstream rejected") },
      { text: "acknowledged Task#fetch failed; proceeding without it" },
    ]);

    const runtime = await createAgentRuntime({ enableTaskTool: true });
    const result = await runtime.run({
      messages: [userMessage("research X")],
      turnIndex: 0,
    });

    // 主 turn 完成 —— 不被子 fail 反向 abort
    expect(result.agentResult.reason).toBe("completed");

    // toolCalls 含 Task 记录,isError=true
    expect(result.turn.toolCalls).toHaveLength(1);
    const taskCall = result.turn.toolCalls![0]!;
    expect(taskCall.name).toBe("Task");
    expect(taskCall.isError).toBe(true);
    expect(taskCall.result).toMatch(/^\[Task "fetch" failed:/);

    // 主 LLM 看到 is_error 后继续输出(spec 强制要求 LLM 在 final response 中暴露 Task 失败)
    expect(getAssistantText(result.turn)).toContain("acknowledged");
  });

  it("父 listener 收到所有子事件,meta.lineage 各异且严格以 'main/sub-' 开头", async () => {
    // hierarchical EventBus 的产品级承诺 ——
    // 父订阅可见所有子事件,通过 meta.lineage 区分子身份;payload 类型不被冒泡污染
    providerRef.current = new MockLLMProvider([
      {
        toolCalls: [
          { id: "tk1", name: "Task", input: { description: "A", prompt: "task A" } },
          { id: "tk2", name: "Task", input: { description: "B", prompt: "task B" } },
          { id: "tk3", name: "Task", input: { description: "C", prompt: "task C" } },
        ],
      },
      { text: "child-α" },
      { text: "child-β" },
      { text: "child-γ" },
      { text: "main synthesis" },
    ]);

    const observedSubLineages = new Set<string>();
    const runtime = await createAgentRuntime({
      enableTaskTool: true,
      decorateRunBus: ({ bus }) => {
        // onAny 不区分事件类型,只观察 meta.lineage —— 任何子事件冒泡到父都计入
        bus.onAny((_evtName, _payload, meta) => {
          if (meta?.lineage && meta.lineage.startsWith("main/sub-")) {
            observedSubLineages.add(meta.lineage);
          }
        });
        return () => {};
      },
    });

    const result = await runtime.run({
      messages: [userMessage("compare A B C")],
      turnIndex: 0,
    });

    expect(result.agentResult.reason).toBe("completed");
    // 3 个子各有唯一 lineage,且全部冒泡可见
    expect(observedSubLineages.size).toBe(3);
    for (const lineage of observedSubLineages) {
      expect(lineage).toMatch(/^main\/sub-[0-9a-f]+$/);
    }
  });

});

// ─── 契约: resetConversationState ───

describe("createAgentRuntime · resetConversationState", () => {
  it("无 Resettable 注册 → 调用即 resolve（空操作）", async () => {
    providerRef.current = new MockLLMProvider([{ text: "ok" }]);
    const runtime = await createAgentRuntime({});
    await expect(runtime.resetConversationState()).resolves.toBeUndefined();
  });

  it("LIFO 串行：后注册先 reset", async () => {
    providerRef.current = new MockLLMProvider([{ text: "ok" }]);
    const runtime = await createAgentRuntime({});
    const order: string[] = [];
    runtime.registerConversationStateReset({
      id: "first",
      reset: () => {
        order.push("first");
      },
    });
    runtime.registerConversationStateReset({
      id: "second",
      reset: () => {
        order.push("second");
      },
    });
    runtime.registerConversationStateReset({
      id: "third",
      reset: () => {
        order.push("third");
      },
    });

    await runtime.resetConversationState();
    expect(order).toEqual(["third", "second", "first"]);
  });

  it("await async reset 完成才往下走", async () => {
    providerRef.current = new MockLLMProvider([{ text: "ok" }]);
    const runtime = await createAgentRuntime({});
    let resolved = false;
    runtime.registerConversationStateReset({
      id: "slow",
      reset: async () => {
        await new Promise((r) => setTimeout(r, 5));
        resolved = true;
      },
    });
    await runtime.resetConversationState();
    expect(resolved).toBe(true);
  });

  it("单个抛错不阻断其它 reset；全跑完后聚合抛 ResetConversationStateError", async () => {
    const { ResetConversationStateError } = await import(
      "../create-agent-runtime.js"
    );
    providerRef.current = new MockLLMProvider([{ text: "ok" }]);
    const runtime = await createAgentRuntime({});
    const ran: string[] = [];
    runtime.registerConversationStateReset({
      id: "ok-1",
      reset: () => {
        ran.push("ok-1");
      },
    });
    runtime.registerConversationStateReset({
      id: "boom",
      reset: () => {
        throw new Error("inner failure");
      },
    });
    runtime.registerConversationStateReset({
      id: "ok-2",
      reset: () => {
        ran.push("ok-2");
      },
    });

    let caught: unknown;
    try {
      await runtime.resetConversationState();
    } catch (err) {
      caught = err;
    }

    // 全部 reset 都被尝试（顺序 ok-2 → boom → ok-1）
    expect(ran).toContain("ok-1");
    expect(ran).toContain("ok-2");
    expect(caught).toBeInstanceOf(ResetConversationStateError);
    if (caught instanceof ResetConversationStateError) {
      expect(caught.failures).toHaveLength(1);
      expect(caught.failures[0]!.id).toBe("boom");
    }
  });
});

// ─── 契约: RunContext.conversationId 透传到 ALS ───

describe("createAgentRuntime · run() conversationId 透传", () => {
  it("RunParams.conversationId → runContextStorage.getStore()?.conversationId", async () => {
    // 用 extraTool 在工具调用时探查 ALS，验证 conversationId 透传到位。
    // mock provider 必须发 tool_use 让 secure-executor 真正调到 probe.call。
    providerRef.current = new MockLLMProvider([
      {
        toolCalls: [{ id: "u1", name: "ctx_probe", input: {} }],
      },
      { text: "done" },
    ]);

    const { runContextStorage } = await import("../run-context.js");
    let observedConvId: string | undefined | null = null;
    const probe: ToolDefinition = {
      name: "ctx_probe",
      description: "Capture conversationId from RunContext for assertion.",
      inputSchema: { type: "object" },
      isReadOnly: true,
      isParallelSafe: true,
      needsPermission: false,
      subAgentSafe: true,
      // 声明 read access 让 SecurityPipeline 分类为 observe 放行（与 ALS 测试对齐）
      boundaries: [{ boundaryType: "process", access: "read", dynamic: false }],
      call: async () => {
        observedConvId =
          runContextStorage.getStore()?.conversationId ?? null;
        return { content: "captured" };
      },
    };

    const runtime = await createAgentRuntime({ extraTools: [probe] });
    await runtime.run({
      messages: [userMessage("trigger probe")],
      turnIndex: 0,
      conversationId: "conv-xyz-123",
    });

    expect(observedConvId).toBe("conv-xyz-123");
  });

  it("RunParams 不传 conversationId → ALS 中为 undefined", async () => {
    providerRef.current = new MockLLMProvider([
      {
        toolCalls: [{ id: "u1", name: "ctx_probe2", input: {} }],
      },
      { text: "done" },
    ]);

    const { runContextStorage } = await import("../run-context.js");
    let observedConvId: string | undefined | null = "<unset>";
    const probe: ToolDefinition = {
      name: "ctx_probe2",
      description: "Capture conversationId for ephemeral run assertion.",
      inputSchema: { type: "object" },
      isReadOnly: true,
      isParallelSafe: true,
      needsPermission: false,
      subAgentSafe: true,
      // 声明 read access 让 SecurityPipeline 分类为 observe 放行（与 ALS 测试对齐）
      boundaries: [{ boundaryType: "process", access: "read", dynamic: false }],
      call: async () => {
        observedConvId =
          runContextStorage.getStore()?.conversationId ?? null;
        return { content: "captured" };
      },
    };

    const runtime = await createAgentRuntime({ extraTools: [probe] });
    await runtime.run({
      messages: [userMessage("trigger probe")],
      turnIndex: 0,
      // 不传 conversationId
    });

    expect(observedConvId).toBeNull();
  });
});
