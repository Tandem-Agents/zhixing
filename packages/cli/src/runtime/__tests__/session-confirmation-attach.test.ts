/**
 * RuntimeSession 确认接线契约 —— attachConfirmation 钩子的守卫与重接拓扑。
 *
 * 范围:锁 session 这一层"钩子在哪些时机、被哪个 broker 调用"——
 *   - 首次登记:钩子接当前 main broker;outer detach 释放绑定、可再登记
 *   - 重复登记:throw(单一确认渠道约束)
 *   - 工作模式 enter/exit:重接 power broker / 切回 main(旧 detach 先调)
 *   - reload:非工作模式重接新 main;工作模式重接新 power(而非新 main)
 *   - dispose:detach 释放
 *   - 未登记接线:全部生命周期操作对接线 no-op,不抛
 *
 * mock 策略与 session-dispose 测试同构:createAgentRuntime stub(每实例独立
 * confirmationBroker 对象,可按引用识别),不真装配 runtime。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── hoisted refs(vi.mock 工厂在 import 前引用)───

const { createAgentRuntimeMock, sceneRegistryStub, diffRef } = vi.hoisted(
  () => ({
    createAgentRuntimeMock: vi.fn(),
    sceneRegistryStub: {
      get: vi.fn(),
      touch: vi.fn(async () => {}),
      list: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
    },
    diffRef: { current: null as unknown },
  }),
);

vi.mock("@zhixing/orchestrator/runtime", async (orig) => {
  const actual = await orig<typeof import("@zhixing/orchestrator/runtime")>();
  return { ...actual, createAgentRuntime: createAgentRuntimeMock };
});

vi.mock("@zhixing/core", async (orig) => {
  const actual = await orig<typeof import("@zhixing/core")>();
  return {
    ...actual,
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

const { RuntimeSession } = await import("../session.js");

// ─── 测试辅助 ───

const runtimeStubs: Array<{
  confirmationBroker: object;
  dispose: ReturnType<typeof vi.fn>;
}> = [];

function makeRuntimeStub() {
  const stub = {
    providerId: "mock",
    model: "mock-model",
    confirmationBroker: {},
    permissionStore: {},
    resolvedWorkspace: { path: null, source: "none" },
    workspaceDirStatus: "exists",
    dispose: vi.fn(async () => {}),
    run: vi.fn(),
    callText: vi.fn(),
  };
  runtimeStubs.push(stub);
  return stub;
}

function makeOptions() {
  return {
    config: { messaging: {} },
    credentials: {},
    decorateRunBus: () => () => {},
    onRuntimeWarning: vi.fn(),
    zhixingHome: "/tmp/zhixing-home",
    schedulerFacade: { dispose: vi.fn(async () => {}) },
    onSecurityBlocked: vi.fn(),
    builtinExtraTools: {
      assembleTools: vi.fn(() => []),
      taskListService: { prime: vi.fn(), clear: vi.fn() },
      mcpHub: { applyConfig: vi.fn(async () => {}) },
    },
    segmentDeps: {},
  } as never;
}

/** 接线钩子 spy——记录每次被哪个 broker 调用,并为每次接线发独立 detach spy。 */
function makeAttachFn() {
  const detaches: Array<ReturnType<typeof vi.fn>> = [];
  const fn = vi.fn((_broker: unknown) => {
    const detach = vi.fn();
    detaches.push(detach);
    return detach;
  });
  return { fn, detaches };
}

const AGENT_CHANGED_DIFF = {
  kind: "changed",
  changedDomains: ["agent"],
  agentChanged: true,
  channelsChanged: false,
};

beforeEach(() => {
  runtimeStubs.length = 0;
  createAgentRuntimeMock.mockReset();
  createAgentRuntimeMock.mockImplementation(async () => makeRuntimeStub());
  sceneRegistryStub.get.mockReset();
  diffRef.current = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("attachConfirmation 登记与释放", () => {
  it("首次登记:钩子接当前 main broker;outer detach 释放后可再登记", async () => {
    const session = await RuntimeSession.create(makeOptions());
    const { fn, detaches } = makeAttachFn();

    const outerDetach = session.attachConfirmation(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]![0]).toBe(runtimeStubs[0]!.confirmationBroker);

    outerDetach();
    expect(detaches[0]).toHaveBeenCalledTimes(1);

    // 释放后再登记不 throw,且重新接 main broker
    const second = makeAttachFn();
    session.attachConfirmation(second.fn);
    expect(second.fn.mock.calls[0]![0]).toBe(
      runtimeStubs[0]!.confirmationBroker,
    );
  });

  it("重复登记 → throw(单一确认渠道)", async () => {
    const session = await RuntimeSession.create(makeOptions());
    session.attachConfirmation(makeAttachFn().fn);

    expect(() => session.attachConfirmation(makeAttachFn().fn)).toThrow(
      /already has a confirmation channel/,
    );
  });

  it("dispose → 当前 detach 被调", async () => {
    const session = await RuntimeSession.create(makeOptions());
    const { fn, detaches } = makeAttachFn();
    session.attachConfirmation(fn);

    await session.dispose();

    expect(detaches[0]).toHaveBeenCalledTimes(1);
  });
});

describe("工作模式与 reload 的重接拓扑", () => {
  it("enterWorkMode → 旧 detach 先调、钩子重接 power broker;exit → 切回 main", async () => {
    sceneRegistryStub.get.mockResolvedValue({ id: "s1", workdir: null });
    const session = await RuntimeSession.create(makeOptions());
    const { fn, detaches } = makeAttachFn();
    session.attachConfirmation(fn);

    await session.enterWorkMode("s1");
    // stubs: [0]=main, [1]=power
    expect(detaches[0]).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[1]![0]).toBe(runtimeStubs[1]!.confirmationBroker);

    await session.exitWorkMode();
    expect(detaches[1]).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn.mock.calls[2]![0]).toBe(runtimeStubs[0]!.confirmationBroker);
  });

  it("reload(非工作模式)→ 重接新 main broker", async () => {
    const session = await RuntimeSession.create(makeOptions());
    const { fn, detaches } = makeAttachFn();
    session.attachConfirmation(fn);

    diffRef.current = AGENT_CHANGED_DIFF;
    const result = await session.reload();

    expect(result.kind).toBe("applied");
    // stubs: [0]=旧 main, [1]=新 main
    expect(detaches[0]).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[1]![0]).toBe(runtimeStubs[1]!.confirmationBroker);
  });

  it("工作模式 reload → 重接新 power broker(而非新 main)", async () => {
    sceneRegistryStub.get.mockResolvedValue({ id: "s1", workdir: null });
    const session = await RuntimeSession.create(makeOptions());
    const { fn } = makeAttachFn();
    session.attachConfirmation(fn);
    await session.enterWorkMode("s1");
    // stubs: [0]=main, [1]=power

    diffRef.current = AGENT_CHANGED_DIFF;
    const result = await session.reload();

    expect(result.kind).toBe("applied");
    // stubs: [2]=新 main, [3]=新 power —— broker 跟当前 active(工作模式)走
    const lastBroker = fn.mock.calls.at(-1)![0];
    expect(lastBroker).toBe(runtimeStubs[3]!.confirmationBroker);
    expect(lastBroker).not.toBe(runtimeStubs[2]!.confirmationBroker);
  });

  it("未登记接线:enter / exit / reload 对接线 no-op,不抛", async () => {
    sceneRegistryStub.get.mockResolvedValue({ id: "s1", workdir: null });
    const session = await RuntimeSession.create(makeOptions());

    await session.enterWorkMode("s1");
    await session.exitWorkMode();
    diffRef.current = AGENT_CHANGED_DIFF;
    const result = await session.reload();

    expect(result.kind).toBe("applied");
  });
});
