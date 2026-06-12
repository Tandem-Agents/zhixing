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

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  AgentError,
  MockLLMProvider,
  SkillStore,
  skillNameToId,
  deriveToolCalls,
  userMessage,
  type IEventBus,
  type LLMRole,
  type LLMRoles,
  type AgentEventMap,
  type ToolDefinition,
} from "@zhixing/core";
import type { RoleDegradation } from "@zhixing/providers";

// ─── hoisted ref:让 vi.mock 工厂在 import 之前能引用 ───

const {
  providerRef,
  powerRoleRef,
  degradationsRef,
  decorateCalls,
  decorateDisposes,
} = vi.hoisted(() => ({
    providerRef: { current: null as MockLLMProvider | null },
    // opt-in 差异化 power 角色：默认 null = power 与 main 折叠（fallback 语义，
    // 既有用例零影响）；设值时 power 用独立 model + provider，让 primaryRole
    // 路由区分可观测断言。
    powerRoleRef: {
      current: null as null | { model: string; provider: MockLLMProvider },
    },
    // opt-in 可选角色降级注入：默认空 = 无降级（既有用例零影响）；设值时
    // mock 的 resolvedRoles.degradations 返回它，驱动边缘层告警分支可断言。
    degradationsRef: { current: [] as RoleDegradation[] },
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
      const mkRole = (p: MockLLMProvider, model: string): LLMRole => ({
        provider: p,
        model,
        chat: (request) => p.chat(request),
      });
      const mainRole = mkRole(provider, "mock-model");
      // powerRoleRef 未设 → power 折叠为 main（fallback 语义，与历史一致）；
      // 设了 → 独立 model + provider 实例，路由区分可断言。
      const powerOverride = powerRoleRef.current;
      const powerRole = powerOverride
        ? mkRole(powerOverride.provider, powerOverride.model)
        : mainRole;
      const roles: LLMRoles = {
        main: mainRole,
        light: mainRole,
        power: powerRole,
      };
      const powerResolved = powerOverride
        ? { resolved: resolvedProvider, model: powerOverride.model }
        : resolvedRole;
      return {
        roles,
        config: { providers: {} } as never,
        resolvedRoles: {
          main: resolvedRole,
          light: resolvedRole,
          power: powerResolved,
          degradations: degradationsRef.current,
        } as never,
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
const { mainProfile } = await import("../../profile/default-profiles.js");

// ─── 测试辅助 ───

beforeEach(() => {
  providerRef.current = null;
  powerRoleRef.current = null;
  degradationsRef.current = [];
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
    // 各自 runRecord 携带本轮用户原文
    expect((r1.runRecord.messages[0]!.content[0] as { text: string }).text).toBe("ask 1");
    expect((r2.runRecord.messages[0]!.content[0] as { text: string }).text).toBe("ask 2");
  });
});

// ─── 契约 5: forceCompact = 强制段切换 ───

describe("createAgentRuntime · forceCompact 强制段切换", () => {
  const SUMMARY_XML = "<facts>F1</facts><state>S1</state><active>A1</active>";

  function sixMessages() {
    const messages = [];
    // 10 turns：被摘段（去掉保留 buffer 2 turns）≥ 记忆提取的 minMessages 门槛
    for (let i = 0; i < 10; i++) {
      messages.push(userMessage(`q${i}`), {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: `a${i}` }],
      });
    }
    return messages;
  }

  it("强制切段成功：阈值置零绕过 defer，产出 windowCompact（含结构化摘要）+ 新段消息；记忆提取随 afterSummarize 触发", async () => {
    // 响应序列：① 段摘要（light）② 记忆提取（light，返回空数组 → 零写盘）
    providerRef.current = new MockLLMProvider([
      { text: SUMMARY_XML },
      { text: "[]" },
    ]);

    const runtime = await createAgentRuntime({});
    const messages = sixMessages();
    const result = await runtime.forceCompact(messages, 10);

    expect(result.modified).toBe(true);
    expect(result.windowCompact).toBeDefined();
    expect(result.windowCompact!.structuredSummary).toEqual({
      facts: "F1",
      state: "S1",
      active: "A1",
    });
    expect(result.windowCompact!.pairsCompacted).toBeGreaterThan(0);
    // 新段：摘要对置首 + 保留最近 buffer，严格短于原文
    expect(result.messages.length).toBeLessThan(messages.length + 2);
    expect(result.budget).toBeDefined();
    // 正常摘要切段无降级信息
    expect(result.emergencyFloor).toBeUndefined();
    // 端到端：段摘要 + 记忆提取共两次 light 调用（提取挂 afterSummarize）
    expect(providerRef.current!.calls.length).toBe(2);
  });

  it("摘要 LLM 失败 → 应急地板机械兜底：emergencyFloor 携根因随返回值交付（降级知情）", async () => {
    // 不可重试错误（auth 不在 retryableTypes）：段管理器 4 次尝试各自快速失败 → 进地板
    const authError = new AgentError("summarize auth fail", "auth");
    providerRef.current = new MockLLMProvider([
      { error: authError },
      { error: authError },
      { error: authError },
      { error: authError },
    ]);

    const runtime = await createAgentRuntime({});
    const result = await runtime.forceCompact(sixMessages(), 10);

    expect(result.modified).toBe(true);
    // 地板产物：机械折叠指令，无结构化摘要（不产快照）
    expect(result.windowCompact).toBeDefined();
    expect(result.windowCompact!.structuredSummary).toBeUndefined();
    // 降级知情：localBus 与 UI 隔离，emergencyFloor 是手动路径唯一的降级交付通道
    expect(result.emergencyFloor).toBeDefined();
    expect(result.emergencyFloor!.droppedTurns).toBeGreaterThan(0);
    // 根因是真实错误链文本（首次 auth 失败 / 连续失败后熔断开），
    // 不再是"摘要解析失败"的间接症状
    expect(result.emergencyFloor!.error).toMatch(/auth fail|Circuit breaker/);
  });

  it("小窗口（全部消息都在保留 buffer 内）→ 静默不切，零 LLM 调用", async () => {
    providerRef.current = new MockLLMProvider([{ text: SUMMARY_XML }]);

    const runtime = await createAgentRuntime({});
    const result = await runtime.forceCompact([userMessage("test")], 0);

    expect(result.modified).toBe(false);
    expect(result.windowCompact).toBeUndefined();
    expect(providerRef.current!.calls.length).toBe(0);
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

  it("自定义 profile.enabledTools 不含 Task → 无 Task 工具装配，run() 正常完成", async () => {
    providerRef.current = new MockLLMProvider([{ text: "no task here" }]);
    // 自定义 profile 排除 Task：装配后 tools[] 无 Task 工具
    const noTaskProfile = {
      ...mainProfile(),
      enabledTools: mainProfile().enabledTools.filter((n) => n !== "Task"),
    };
    const runtime = await createAgentRuntime({ profile: noTaskProfile });
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

// ─── 契约 7: profile 含 Task 时装配 —— Task 可被 LLM 派调,完成端到端委派 ───

describe("createAgentRuntime · Task 装配契约（profile.enabledTools 驱动）", () => {
  it("profile 含 Task:LLM 调 Task → 子 agent 跑完 → 主收到 tool_result 综合输出", async () => {
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

    const runtime = await createAgentRuntime({ profile: mainProfile() });
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

  it("profile 含 Task:Task 不进入子 agent 工具集(防递归不变量)", async () => {
    // 不直接观察 tools 数组(runtime 不暴露),通过派 Task 让子尝试再派 Task 触发 unknown tool 路径
    // —— 子工具集由 sub-agent profile.enabledTools 决定,不含 Task
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

    const runtime = await createAgentRuntime({ profile: mainProfile() });
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
// 子 agent 各路径状态机已被单测覆盖;集成层在 createAgentRuntime + profile 含 Task
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
  /** 抽出 runRecord 末条 assistant 的纯文本(便于断言主综合输出) */
  function getAssistantText(record: {
    messages: readonly { role: string; content: readonly unknown[] }[];
  }): string {
    const assistants = record.messages.filter((m) => m.role === "assistant");
    const last = assistants[assistants.length - 1];
    if (!last) return "";
    return last.content
      .filter((b): b is { type: "text"; text: string } =>
        typeof b === "object" && b !== null && (b as { type: string }).type === "text",
      )
      .map((b) => b.text)
      .join("");
  }

  /** 从 runRecord 派生扁平工具调用清单(断言用,与生产 deriveToolCalls 同源) */
  function toolCallsOf(record: { messages: readonly unknown[] }) {
    return deriveToolCalls(record.messages as never);
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

    const runtime = await createAgentRuntime({ profile: mainProfile() });
    const result = await runtime.run({
      messages: [userMessage("user question")],
      turnIndex: 0,
    });

    expect(result.agentResult.reason).toBe("completed");

    // runRecord.messages[0] 是用户原始消息(非子的"Begin"伪 user message)
    const userText = (
      result.runRecord.messages[0]!.content[0] as { text: string }
    ).text;
    expect(userText).toBe("user question");

    // 主 turn.assistantMessage 是主综合 —— 不含子 final 文本(子文本是 tool_result.content,不是独立 assistant)
    const assistantText = getAssistantText(result.runRecord);
    expect(assistantText).toContain("[main-only marker]");
    expect(assistantText).not.toContain("[child-only marker]");

    // 主 turn.toolCalls 含 Task 一条记录,result 字段(扁平化字符串)含子 final
    expect(toolCallsOf(result.runRecord)).toHaveLength(1);
    const taskCall = toolCallsOf(result.runRecord)[0]!;
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
    // Task isParallelSafe=true,主同 turn 派 3 个可并发(不进子工具集由 sub-agent
    // profile.enabledTools 不含 Task 保证)。
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

    const runtime = await createAgentRuntime({ profile: mainProfile() });
    const result = await runtime.run({
      messages: [userMessage("compare A vs B vs C")],
      turnIndex: 0,
    });

    expect(result.agentResult.reason).toBe("completed");
    // 5 次 chat: 1 主分发 + 3 子终结 + 1 主综合
    expect(providerRef.current!.callCount).toBe(5);

    // 主 turn 含 3 条 toolCalls,各自 success
    const calls = toolCallsOf(result.runRecord);
    expect(calls).toHaveLength(3);
    for (const tc of calls) {
      expect(tc.name).toBe("Task");
      expect(tc.isError).toBeFalsy();
    }
    // 3 条 result 字符串覆盖 3 个子 final(顺序未定 —— callIndex sync 但完成顺序与
    // 子 finalize 顺序耦合,我们只需断言三者全部出现)
    const allResults = calls.map((tc) => tc.result).join("\n");
    expect(allResults).toContain("child-final-α");
    expect(allResults).toContain("child-final-β");
    expect(allResults).toContain("child-final-γ");

    // 主综合输出
    expect(getAssistantText(result.runRecord)).toContain("synthesized A+B+C");
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

    const runtime = await createAgentRuntime({ profile: mainProfile() });
    const result = await runtime.run({
      messages: [userMessage("research X")],
      turnIndex: 0,
    });

    // 主 turn 完成 —— 不被子 fail 反向 abort
    expect(result.agentResult.reason).toBe("completed");

    // toolCalls 含 Task 记录,isError=true
    const errCalls = toolCallsOf(result.runRecord);
    expect(errCalls).toHaveLength(1);
    const taskCall = errCalls[0]!;
    expect(taskCall.name).toBe("Task");
    expect(taskCall.isError).toBe(true);
    // type tag 透传:format 为 [Task "<desc>" failed (<type>): <msg>],含真实 AgentErrorType
    expect(taskCall.result).toMatch(/^\[Task "fetch" failed \(provider_error\):/);

    // 主 LLM 看到 is_error 后继续输出(spec 强制要求 LLM 在 final response 中暴露 Task 失败)
    expect(getAssistantText(result.runRecord)).toContain("acknowledged");
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
      profile: mainProfile(),
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

// ─── 契约: primaryRole 槽位路由 ───

describe("createAgentRuntime · primaryRole 槽位", () => {
  it("primaryRole='power' 未配（fallback main）→ 路径正常装配，model 取 fallback", async () => {
    providerRef.current = new MockLLMProvider([{ text: "ok" }]);
    // powerRoleRef 未设 → power 折叠为 main（fallback 语义）
    const runtime = await createAgentRuntime({ primaryRole: "power" });
    expect(runtime.model).toBe("mock-model");
  });

  it("primaryRole='power' + 差异化 power → 六处可观测点（返回 model + loop LLM）指向 power，非 main", async () => {
    const mainProvider = new MockLLMProvider([{ text: "from-main" }]);
    const powerProvider = new MockLLMProvider([{ text: "from-power" }]);
    providerRef.current = mainProvider;
    powerRoleRef.current = { model: "power-model", provider: powerProvider };

    const runtime = await createAgentRuntime({ primaryRole: "power" });

    // 返回 providerId+model（六处之一，直接可观测）指向 power
    expect(runtime.model).toBe("power-model");

    await runtime.run({ messages: [userMessage("hi")], turnIndex: 0 });

    // 主对话 loop 的 LLM 调用打到 power provider，main provider 零调用
    expect(powerProvider.calls.length).toBeGreaterThan(0);
    expect(mainProvider.calls.length).toBe(0);
  });

  it("控制组：同样差异化 power 但缺省 primaryRole(main) → 仍指向 main，证明切换由 primaryRole 驱动", async () => {
    const mainProvider = new MockLLMProvider([{ text: "from-main" }]);
    const powerProvider = new MockLLMProvider([{ text: "from-power" }]);
    providerRef.current = mainProvider;
    powerRoleRef.current = { model: "power-model", provider: powerProvider };

    const runtime = await createAgentRuntime({}); // 缺省 primaryRole = main

    expect(runtime.model).toBe("mock-model");

    await runtime.run({ messages: [userMessage("hi")], turnIndex: 0 });

    expect(mainProvider.calls.length).toBeGreaterThan(0);
    expect(powerProvider.calls.length).toBe(0);
  });
});

// ─── 契约: 可选角色降级 → 边缘层可见非致命告警 ───

describe("createAgentRuntime · 可选角色降级可见告警", () => {
  it("degradations 非空 → [zhixing] console.warn 含角色中文名 + 原配置，且不抛", async () => {
    degradationsRef.current = [
      {
        role: "light",
        configured: { provider: "openai", model: "gpt-4o-mini" },
        reason: "凭证或必要配置缺失",
      },
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // 降级永不阻断 agent 创建
      const runtime = await createAgentRuntime({});
      expect(runtime).toBeDefined();

      const msg = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(msg).toContain("[zhixing]");
      expect(msg).toContain("轻量模型"); // ROLE_SPECS light.labelZh（单一事实源）
      expect(msg).toContain("openai · gpt-4o-mini"); // 如实回放用户原配置
      expect(msg).toContain("已回退主模型");
    } finally {
      warn.mockRestore();
    }
  });

  it("degradations 为空 → 不产生降级告警", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await createAgentRuntime({});
      const msg = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(msg).not.toContain("已回退主模型");
    } finally {
      warn.mockRestore();
    }
  });
});

// ─── 契约: 运行体生命周期钩子 ───

describe("createAgentRuntime · 生命周期钩子", () => {
  const SKILL_MARKER = "ZX_LIFECYCLE_SKILL_MARKER";

  it("首窗 onWindowOpen(instance-start, windowIndex=0) 在装配期触发,贡献的段进 systemPrompt", async () => {
    providerRef.current = new MockLLMProvider([{ text: "ok" }]);
    const opens: { reason: string; windowIndex: number }[] = [];

    const runtime = await createAgentRuntime({
      lifecycle: [
        {
          id: "test-sub",
          onWindowOpen: (ctx) => {
            opens.push({ reason: ctx.reason, windowIndex: ctx.windowIndex });
            ctx.updateSystemPromptSegment("skill-index", SKILL_MARKER);
          },
        },
      ],
    });

    // 首窗在装配期已触发（不等 run）
    expect(opens).toEqual([{ reason: "instance-start", windowIndex: 0 }]);

    await runtime.run({ messages: [userMessage("hi")], turnIndex: 0 });
    // 贡献的 skill-index 段进了首个 LLM call 的 system prompt
    expect(providerRef.current.calls[0]!.systemPrompt).toContain(SKILL_MARKER);
  });

  it("run() 触发 onBeforeRun(观测原始输入 messages) → onAfterRun(RunResult),顺序与字段正确", async () => {
    providerRef.current = new MockLLMProvider([{ text: "done" }]);
    const order: string[] = [];
    let beforeMsgCount: number | undefined;
    let afterReason: string | undefined;
    let afterTurnIndex: number | undefined;

    const runtime = await createAgentRuntime({
      lifecycle: [
        {
          id: "test-sub",
          onBeforeRun: (ctx) => {
            order.push("before");
            beforeMsgCount = ctx.messages.length;
          },
          onAfterRun: (ctx) => {
            order.push("after");
            afterReason = ctx.result.agentResult.reason;
            afterTurnIndex = ctx.turnIndex;
          },
        },
      ],
    });

    await runtime.run({ messages: [userMessage("hi")], turnIndex: 7 });

    expect(order).toEqual(["before", "after"]);
    expect(beforeMsgCount).toBe(1); // onBeforeRun 观测到的是用户原始输入
    expect(afterReason).toBe("completed");
    expect(afterTurnIndex).toBe(7);
  });

  it("首窗 onWindowOpen(instance-start) 抛错 → createAgentRuntime 失败(安全回滚)", async () => {
    providerRef.current = new MockLLMProvider([{ text: "ok" }]);

    await expect(
      createAgentRuntime({
        lifecycle: [
          {
            id: "boom",
            onWindowOpen: () => {
              throw new Error("first window boom");
            },
          },
        ],
      }),
    ).rejects.toThrow("first window boom");
  });

  it("onBeforeRun 抛错不阻塞 run → emit lifecycle:hook_failed + 继续完成", async () => {
    providerRef.current = new MockLLMProvider([{ text: "ok" }]);
    const failed: { hookId: string; phase: string }[] = [];

    const runtime = await createAgentRuntime({
      decorateRunBus: (ctx) =>
        ctx.bus.on("lifecycle:hook_failed", (e) =>
          failed.push({ hookId: e.hookId, phase: e.phase }),
        ),
      lifecycle: [
        {
          id: "flaky",
          onBeforeRun: () => {
            throw new Error("before boom");
          },
        },
      ],
    });

    const result = await runtime.run({
      messages: [userMessage("hi")],
      turnIndex: 0,
    });

    expect(result.agentResult.reason).toBe("completed");
    expect(failed).toContainEqual({ hookId: "flaky", phase: "onBeforeRun" });
  });

  it("窗口内多 turn:无换代时每个 LLM call 的 systemPrompt byte-equal", async () => {
    providerRef.current = new MockLLMProvider([
      { toolCalls: [{ id: "p1", name: "probe", input: {} }] },
      { text: "done" },
    ]);
    const probe: ToolDefinition = {
      name: "probe",
      description: "test probe",
      inputSchema: { type: "object" as const },
      isReadOnly: true,
      isParallelSafe: true,
      needsPermission: false,
      call: async () => ({ content: "ok" }),
    };

    const runtime = await createAgentRuntime({
      extraTools: [probe],
      lifecycle: [
        {
          id: "test-sub",
          onWindowOpen: (ctx) =>
            ctx.updateSystemPromptSegment("skill-index", SKILL_MARKER),
        },
      ],
    });

    await runtime.run({ messages: [userMessage("hi")], turnIndex: 0 });

    // 两次 LLM call（工具轮 + 收尾轮）—— 同一窗口内无换代,systemPrompt byte-equal
    expect(providerRef.current.calls.length).toBe(2);
    expect(providerRef.current.calls[0]!.systemPrompt).toBe(
      providerRef.current.calls[1]!.systemPrompt,
    );
    expect(providerRef.current.calls[0]!.systemPrompt).toContain(SKILL_MARKER);
  });

  it("dispose(reason) 触发末窗 onWindowClose(reason 透传),幂等", async () => {
    providerRef.current = new MockLLMProvider([{ text: "ok" }]);
    const closes: string[] = [];

    const runtime = await createAgentRuntime({
      lifecycle: [
        {
          id: "test-sub",
          onWindowClose: (ctx) => {
            closes.push(ctx.reason);
          },
        },
      ],
    });

    await runtime.dispose("session-dispose");
    expect(closes).toEqual(["session-dispose"]);

    // 幂等：第二次起 no-op（reason 取首次）
    await runtime.dispose("workmode-exit");
    expect(closes).toEqual(["session-dispose"]);
  });

  it("首窗 open(windowIndex=0) 与末窗 close 配对", async () => {
    providerRef.current = new MockLLMProvider([{ text: "ok" }]);
    const opens: number[] = [];
    const closes: { reason: string; windowIndex: number }[] = [];

    const runtime = await createAgentRuntime({
      lifecycle: [
        {
          id: "test-sub",
          onWindowOpen: (ctx) => opens.push(ctx.windowIndex),
          onWindowClose: (ctx) =>
            closes.push({ reason: ctx.reason, windowIndex: ctx.windowIndex }),
        },
      ],
    });

    expect(opens).toEqual([0]); // 首窗 windowIndex 0
    await runtime.dispose("session-dispose");
    // 末窗 = 首窗 index（无中间换代）
    expect(closes).toEqual([{ reason: "session-dispose", windowIndex: 0 }]);
  });

  it("onAttentionWindowChange(clear): onWindowClose(clear)→onWindowOpen(clear),更新实例权威", async () => {
    providerRef.current = new MockLLMProvider([{ text: "1" }, { text: "2" }]);
    const events: string[] = [];
    let openCount = 0;

    const runtime = await createAgentRuntime({
      lifecycle: [
        {
          id: "test-sub",
          onWindowOpen: (ctx) => {
            events.push(`open:${ctx.reason}`);
            ctx.updateSystemPromptSegment("skill-index", `SKILL_v${openCount++}`);
          },
          onWindowClose: (ctx) => {
            events.push(`close:${ctx.reason}`);
          },
        },
      ],
    });

    // 首窗已 open（贡献 v0）
    expect(events).toEqual(["open:instance-start"]);
    await runtime.run({ messages: [userMessage("a")], turnIndex: 0 });
    expect(providerRef.current.calls[0]!.systemPrompt).toContain("SKILL_v0");

    // clear 换代：close(clear) → open(clear)（贡献 v1）
    await runtime.onAttentionWindowChange("clear");
    expect(events).toEqual(["open:instance-start", "close:clear", "open:clear"]);

    // 下个 run 入口 capture 更新后的实例权威（含 v1、不再是 v0）
    await runtime.run({ messages: [userMessage("b")], turnIndex: 1 });
    expect(providerRef.current.calls[1]!.systemPrompt).toContain("SKILL_v1");
    expect(providerRef.current.calls[1]!.systemPrompt).not.toContain("SKILL_v0");
  });

  it("末窗 onWindowClose 抛错 → dispose 抛 LifecycleHookError,不阻断其他订阅者", async () => {
    providerRef.current = new MockLLMProvider([{ text: "ok" }]);
    const closed: string[] = [];

    const runtime = await createAgentRuntime({
      lifecycle: [
        {
          id: "boom",
          onWindowClose: () => {
            throw new Error("close boom");
          },
        },
        {
          id: "ok-sub",
          onWindowClose: () => {
            closed.push("ok-sub");
          },
        },
      ],
    });

    await expect(runtime.dispose("session-dispose")).rejects.toThrow("dispose");
    // 抛错订阅者不阻断后续订阅者
    expect(closed).toEqual(["ok-sub"]);
  });

  it("并发隔离:实例权威在 run 飞行中途更新,该 run 窗口内 systemPrompt 不变", async () => {
    // 锁 Inv-2 承重面:本 run 局部 prompt 私有 + 入口 capture 快照 —— 飞行 run 的
    // getSystemPrompt 在其窗口内不被外部实例级换代穿透。用 probe 工具 gate 把 run
    // 卡在两个 LLM call 之间,期间经 onAttentionWindowChange 改实例权威(模拟另一
    // 并发操作的换代),验证该 run 第二个 call 仍取入口 capture 的旧值。
    providerRef.current = new MockLLMProvider([
      { toolCalls: [{ id: "p1", name: "probe", input: {} }] },
      { text: "done" },
    ]);
    let openVersion = 0;
    let probeEntered!: () => void;
    const probeReady = new Promise<void>((r) => {
      probeEntered = r;
    });
    let gateResolve!: () => void;
    const gate = new Promise<void>((r) => {
      gateResolve = r;
    });
    const probe: ToolDefinition = {
      name: "probe",
      description: "gate probe",
      inputSchema: { type: "object" as const },
      isReadOnly: true,
      isParallelSafe: true,
      needsPermission: false,
      // 声明 app-state read 边界 —— 经 BoundaryRegistry.fromTools(baseTools) 注册进
      // registry,boundary classifier 据此判 low-impact 放行;否则无 boundaries 的
      // 未知工具 fail-closed → critical → ci 模式 block,probe.call 不执行。
      boundaries: [{ boundaryType: "app-state", access: "read", dynamic: false }],
      call: async () => {
        probeEntered();
        await gate;
        return { content: "ok" };
      },
    };

    const runtime = await createAgentRuntime({
      extraTools: [probe],
      // 放行 probe —— 测试环境无 confirmation renderer,默认 deny 会让 probe.call
      // 不执行、gate 永不进入。allow 让工具真执行,run 在两 call 之间卡在 gate。
      confirmationFallback: "allow",
      lifecycle: [
        {
          id: "test-sub",
          onWindowOpen: (ctx) =>
            ctx.updateSystemPromptSegment("skill-index", `V${openVersion++}`),
        },
      ],
    });

    // 飞行 run 入口 capture V0;第一个 call 发出后卡在 probe(两 call 之间）
    const inflight = runtime.run({ messages: [userMessage("x")], turnIndex: 0 });
    await probeReady;

    // 飞行中途改实例权威(V1）—— 不得穿透飞行 run 的局部 prompt
    await runtime.onAttentionWindowChange("clear");
    gateResolve();
    await inflight;

    expect(providerRef.current.calls.length).toBe(2);
    expect(providerRef.current.calls[0]!.systemPrompt).toContain("V0");
    expect(providerRef.current.calls[1]!.systemPrompt).toContain("V0");
    expect(providerRef.current.calls[1]!.systemPrompt).not.toContain("V1");
  });

  it("run() 自身抛错时 onBeforeRun 触发、onAfterRun 不触发(非强配对)", async () => {
    providerRef.current = new MockLLMProvider([{ text: "ok" }]);
    let beforeCalled = false;
    let afterCalled = false;

    const runtime = await createAgentRuntime({
      lifecycle: [
        {
          id: "test-sub",
          onBeforeRun: () => {
            beforeCalled = true;
          },
          onAfterRun: () => {
            afterCalled = true;
          },
        },
      ],
    });

    // onYield 抛错 → 传播出 runMainLoop → run() reject(ALS 内抛,onAfterRun 不触发)
    await expect(
      runtime.run({
        messages: [userMessage("hi")],
        turnIndex: 0,
        onYield: () => {
          throw new Error("yield boom");
        },
      }),
    ).rejects.toThrow("yield boom");

    expect(beforeCalled).toBe(true);
    expect(afterCalled).toBe(false);
  });

  it("内置 skill 订阅者:索引段含 builtin 条目(双池拼装),own 同名时遮蔽", async () => {
    providerRef.current = new MockLLMProvider([{ text: "ok" }, { text: "ok" }]);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-lc-builtin-"));
    try {
      // 空库:索引段仍含 builtin「提炼技能」(builtin 不依赖用户技能存在)
      const runtime = await createAgentRuntime({
        skillStore: new SkillStore(root),
      });
      await runtime.run({ messages: [userMessage("hi")], turnIndex: 0 });
      expect(providerRef.current.calls[0]!.systemPrompt).toContain("提炼技能");

      // own 同名:用户版生效,builtin 条目退出索引(描述以用户版为准)
      const dir = path.join(root, "own", "distill-fork");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "SKILL.md"),
        "---\nname: 提炼技能\ndescription: 用户定制版描述\n---\nbody",
        "utf-8",
      );
      const runtime2 = await createAgentRuntime({
        skillStore: new SkillStore(root),
      });
      await runtime2.run({ messages: [userMessage("hi")], turnIndex: 0 });
      const prompt2 = providerRef.current.calls[1]!.systemPrompt!;
      expect(prompt2).toContain("用户定制版描述");
      expect(prompt2).not.toContain("加载本方法来起草");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("内置 skill 订阅者:own 同名 fork 被禁用 → builtin 不回落索引(遮蔽按含 disabled 全集,展示与加载一致)", async () => {
    providerRef.current = new MockLLMProvider([{ text: "ok" }]);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-lc-disabled-"));
    try {
      const dir = path.join(root, "own", "distill-fork");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "SKILL.md"),
        "---\nname: 提炼技能\ndescription: 用户定制版描述\n---\nbody",
        "utf-8",
      );
      const store = new SkillStore(root);
      await store.setState(skillNameToId("提炼技能"), { disabled: true });

      const runtime = await createAgentRuntime({ skillStore: store });
      await runtime.run({ messages: [userMessage("hi")], turnIndex: 0 });
      const prompt = providerRef.current.calls[0]!.systemPrompt!;
      // 禁用 = 该 id 从索引整体消失(用户版剔除、builtin 不得回落——loadText
      // 指名加载仍出用户版,索引若显示 builtin 文案则展示与加载指向两份内容)
      expect(prompt).not.toContain("用户定制版描述");
      expect(prompt).not.toContain("加载本方法来起草");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("内置 skill 订阅者:version 未变 → 窗口换代零重算(不扫盘)", async () => {
    providerRef.current = new MockLLMProvider([{ text: "ok" }]);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skills-lc-"));
    try {
      const store = new SkillStore(root);
      const querySpy = vi.spyOn(store, "queryTopN");

      const runtime = await createAgentRuntime({ skillStore: store });
      // 首窗:version(0) ≠ builtVersion(-1) → 重算一次
      expect(querySpy).toHaveBeenCalledTimes(1);

      // clear 换代:version 仍 0 = builtVersion 0 → 零重算、不扫盘
      await runtime.onAttentionWindowChange("clear");
      expect(querySpy).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("dispose 透传销毁类 reason 到末窗 onWindowClose(assembly-rollback)", async () => {
    providerRef.current = new MockLLMProvider([{ text: "ok" }]);
    const closes: string[] = [];
    const runtime = await createAgentRuntime({
      lifecycle: [
        { id: "test-sub", onWindowClose: (ctx) => closes.push(ctx.reason) },
      ],
    });
    await runtime.dispose("assembly-rollback");
    expect(closes).toEqual(["assembly-rollback"]);
  });
});

// ─── 信任上下文装配:场景实例用场景信任(会话锚),非场景维持路径锚 ───

describe("trustContext 装配分叉", () => {
  it("workscene memoryScope → scene 信任与 scene 权限上下文(allow-context 沉淀进场景语境)", async () => {
    providerRef.current = new MockLLMProvider([{ text: "ok" }]);
    const runtime = await createAgentRuntime({
      workspace: null,
      memoryScope: { kind: "workscene", sceneId: "s1" },
    });
    expect(runtime.securityPipeline.getTrust()).toEqual({
      kind: "scene",
      sceneId: "s1",
    });
    expect(runtime.securityPipeline.getContextId()).toEqual({
      kind: "scene",
      sceneId: "s1",
    });
  });

  it("非场景实例:无工作区 → global 信任与 main 上下文", async () => {
    providerRef.current = new MockLLMProvider([{ text: "ok" }]);
    const runtime = await createAgentRuntime({ workspace: null });
    expect(runtime.securityPipeline.getTrust()).toEqual({ kind: "global" });
    expect(runtime.securityPipeline.getContextId()).toEqual({ kind: "main" });
  });
});
