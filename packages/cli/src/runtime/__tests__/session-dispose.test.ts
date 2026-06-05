/**
 * RuntimeSession 销毁链 / reload 换实例 / 装配回滚的末窗 onWindowClose 触发契约。
 *
 * 范围:验证 cli 编排在四条实例退场路径上接上 AgentRuntime.dispose(reason),reason
 * 透传末窗 onWindowClose —— **不**测 AgentRuntime 内部钩子行为(那归 orchestrator
 * create-agent-runtime 测试),只锁 cli 这一层"调没调、reason 对不对"。
 *
 * 覆盖:
 *   - dispose() → main dispose("session-dispose");工作模式下 work 先于 main
 *   - exitWorkMode() → work dispose("workmode-exit")
 *   - reload 换 main → 旧 main dispose("reload-replace")(不搭 disposeOldInBackground)
 *   - 装配回滚 → 已激活新实例 dispose("assembly-rollback")(不静默 GC)
 *
 * mock 策略:createAgentRuntime stub(dispose spy) + Scheduler / 注册表 / 配置 loader
 * / diff 全 stub —— 不真装配 main runtime,聚焦 cli 编排的 dispose 调用拓扑。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus, type AgentEventMap } from "@zhixing/core";

// ─── hoisted refs(vi.mock 工厂在 import 前引用)───

const { createAgentRuntimeMock, schedulerStub, sceneRegistryStub, diffRef } =
  vi.hoisted(() => ({
    createAgentRuntimeMock: vi.fn(),
    schedulerStub: {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      getStatusSummary: vi.fn(() => ""),
    },
    sceneRegistryStub: {
      get: vi.fn(),
      touch: vi.fn(async () => {}),
      list: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
    },
    diffRef: { current: null as unknown },
  }));

vi.mock("@zhixing/orchestrator/runtime", async (orig) => {
  const actual = await orig<typeof import("@zhixing/orchestrator/runtime")>();
  return { ...actual, createAgentRuntime: createAgentRuntimeMock };
});

vi.mock("@zhixing/core", async (orig) => {
  const actual = await orig<typeof import("@zhixing/core")>();
  return {
    ...actual,
    Scheduler: vi.fn(() => schedulerStub),
    JsonTaskStore: vi.fn(() => ({})),
    FsWorkSceneRegistry: vi.fn(() => sceneRegistryStub),
    SkillStore: vi.fn(() => ({})),
  };
});

vi.mock("@zhixing/providers", async (orig) => {
  const actual = await orig<typeof import("@zhixing/providers")>();
  return {
    ...actual,
    loadConfig: () => ({ messaging: {} }),
    loadCredentials: () => ({}),
    resolveHomeDir: () => "/tmp/zhixing-home",
  };
});

vi.mock("../diff.js", () => ({
  computeDiff: () => diffRef.current,
}));

vi.mock("../turn-context-providers.js", () => ({
  registerCliTurnContextProviders: vi.fn(),
}));

vi.mock("../../render.js", () => ({
  createRenderSubscribers: () => () => () => {},
}));

const { RuntimeSession } = await import("../session.js");

// ─── 测试辅助 ───

const runtimeStubs: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];

function makeRuntimeStub() {
  const stub = {
    providerId: "mock",
    model: "mock-model",
    confirmationBroker: {},
    permissionStore: {},
    securityPipeline: {},
    resolvedWorkspace: { path: null, source: "none" },
    workspaceDirStatus: "exists",
    calibrationFactor: 1,
    registerTurnContextProvider: vi.fn(),
    registerConversationStateReset: vi.fn(),
    resetConversationState: vi.fn(async () => {}),
    onAttentionWindowChange: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    run: vi.fn(),
    checkBudget: vi.fn(),
    forceCompact: vi.fn(),
    callText: vi.fn(),
  };
  runtimeStubs.push(stub);
  return stub;
}

function makeOptions() {
  return {
    config: { messaging: {} },
    credentials: {},
    renderer: { stop: vi.fn() },
    writer: { notify: vi.fn(), line: vi.fn() },
    zhixingHome: "/tmp/zhixing-home",
    schedulerEventBus: createEventBus<AgentEventMap>(),
    onSecurityBlocked: vi.fn(),
    builtinExtraTools: {
      assembleTools: vi.fn(() => []),
      taskListService: { prime: vi.fn(), clear: vi.fn() },
      mcpHub: { applyConfig: vi.fn(async () => {}) },
    },
    segmentDeps: {},
  } as never;
}

beforeEach(() => {
  runtimeStubs.length = 0;
  createAgentRuntimeMock.mockReset();
  createAgentRuntimeMock.mockImplementation(async () => makeRuntimeStub());
  schedulerStub.start.mockClear();
  schedulerStub.stop.mockClear();
  sceneRegistryStub.get.mockReset();
  diffRef.current = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("RuntimeSession 销毁链末窗 onWindowClose", () => {
  it("dispose() → main 运行体 dispose('session-dispose')", async () => {
    const session = await RuntimeSession.create(makeOptions());
    const main = runtimeStubs[0]!;

    await session.dispose();

    expect(main.dispose).toHaveBeenCalledWith("session-dispose");
  });

  it("dispose() 工作模式下:work 先 dispose('session-dispose'),再 main", async () => {
    sceneRegistryStub.get.mockResolvedValue({ id: "s1", workdir: null });
    const session = await RuntimeSession.create(makeOptions());
    const main = runtimeStubs[0]!;
    await session.enterWorkMode("s1");
    const work = runtimeStubs[1]!;

    await session.dispose();

    expect(work.dispose).toHaveBeenCalledWith("session-dispose");
    expect(main.dispose).toHaveBeenCalledWith("session-dispose");
    // work 末窗先于 main(置 workScene=undefined 前)
    expect(work.dispose.mock.invocationCallOrder[0]!).toBeLessThan(
      main.dispose.mock.invocationCallOrder[0]!,
    );
  });

  it("exitWorkMode() → work 运行体 dispose('workmode-exit')", async () => {
    sceneRegistryStub.get.mockResolvedValue({ id: "s1", workdir: null });
    const session = await RuntimeSession.create(makeOptions());
    await session.enterWorkMode("s1");
    const work = runtimeStubs[1]!;

    await session.exitWorkMode();

    expect(work.dispose).toHaveBeenCalledWith("workmode-exit");
  });

  it("reload 换 main → 旧 main dispose('reload-replace')", async () => {
    const session = await RuntimeSession.create(makeOptions());
    const oldMain = runtimeStubs[0]!;

    // agent 域变化 → 重建 main、swap、退役旧实例
    diffRef.current = {
      kind: "changed",
      changedDomains: ["agent"],
      agentChanged: true,
      channelsChanged: false,
    };
    const result = await session.reload();

    expect(result.kind).toBe("applied");
    expect(oldMain.dispose).toHaveBeenCalledWith("reload-replace");
  });

  it("装配回滚:工作模式 reload 中 power 重建失败 → 新 main dispose('assembly-rollback')", async () => {
    // enterWorkMode 时 scene 存在(成功 enter);reload 重建 power 时 scene 已不存在
    sceneRegistryStub.get
      .mockResolvedValueOnce({ id: "s1", workdir: null }) // enterWorkMode
      .mockResolvedValue(null); // reload 重建 power → 不存在 → throw
    const session = await RuntimeSession.create(makeOptions());
    await session.enterWorkMode("s1");
    // stubs: [0]=main, [1]=power

    diffRef.current = {
      kind: "changed",
      changedDomains: ["agent"],
      agentChanged: true,
      channelsChanged: false,
    };
    const result = await session.reload();

    // 新 main(stubs[2]) 已激活(首窗 open)、但兄弟步骤(power 重建)抛错 → 补末窗
    const newMain = runtimeStubs[2]!;
    expect(result.kind).toBe("failed");
    expect(newMain.dispose).toHaveBeenCalledWith("assembly-rollback");
  });
});
