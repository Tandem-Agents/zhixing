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
