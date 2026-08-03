/**
 * RuntimeHost 装配契约 —— 资产透传与各类 runtime 发放路径。
 *
 * 范围:锁 host 这一层"装配参数从哪来、origin 何时定"——
 *   - 资产层透传:skillStore / segmentDeps / decorateRunBus 按引用直达
 *     createAgentRuntime;extra tools 经 assembly 装配;main/ephemeral 工作区由
 *     createAgentRuntime 按配置解析,host 不持用户启动覆盖
 *   - schedule 工具只持 scheduler facade；权威来源由 owner 从 ingress 反绑
 *   - onRuntimeCreated:两条发放路径都被调用(杜绝"某入口漏注册")
 *
 * mock 策略:createAgentRuntime stub 捕获装配参数;assembly 用真实形态的最小
 * stub(assembleTools 透传 ctx 供断言)。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentRuntimeMock } = vi.hoisted(() => ({
  createAgentRuntimeMock: vi.fn(),
}));

vi.mock("@zhixing/orchestrator/runtime", async (orig) => {
  const actual = await orig<typeof import("@zhixing/orchestrator/runtime")>();
  return { ...actual, createAgentRuntime: createAgentRuntimeMock };
});

const { RuntimeHost } = await import("@zhixing/runtime-host/runtime-host");

// ─── 测试辅助 ───

type AssembledCtx = {
  scheduler: () => unknown;
};

function makeHostOptions() {
  const assembled: AssembledCtx[] = [];
  const onRuntimeCreated = vi.fn();
  const skillStore = { marker: "skill-store" };
  const segmentDeps = { marker: "segment-deps" };
  const decorateRunBus = () => () => {};
  const tools = [{ name: "schedule" }];
  const options = {
    systemProtectedPaths: ["/host/credentials.json", "/host/secret-vault"],
    skillStore,
    segmentDeps,
    extraTools: {
      taskListService: {},
      mcpHub: { catalog: vi.fn(() => []) },
      assembleTools: vi.fn((ctx: AssembledCtx) => {
        assembled.push(ctx);
        return tools;
      }),
    },
    scheduler: () => ({ marker: "facade" }),
    decorateRunBus,
    onSecurityBlocked: vi.fn(),
    onRuntimeCreated,
  } as never;
  return { options, assembled, onRuntimeCreated, skillStore, segmentDeps, decorateRunBus, tools };
}

beforeEach(() => {
  createAgentRuntimeMock.mockReset();
  createAgentRuntimeMock.mockImplementation(async () => ({
    marker: "runtime",
  }));
});

describe("资产层透传", () => {
  it("skillStore / segmentDeps / decorateRunBus 按引用直达装配,main 不注入 workspace 覆盖", async () => {
    const { options, skillStore, segmentDeps, decorateRunBus, tools } =
      makeHostOptions();
    const host = new RuntimeHost(options);

    await host.createConversationRuntime();

    const params = createAgentRuntimeMock.mock.calls[0]![0];
    expect(params.skillStore).toBe(skillStore);
    expect(params.segmentDeps).toBe(segmentDeps);
    expect(params.decorateRunBus).toBe(decorateRunBus);
    expect(params.workspace).toBeUndefined();
    expect(params.extraTools).toBe(tools);
    expect(params.runtimeKind).toBe("conversation");
    expect(params.systemProtectedPaths).toBe(options.systemProtectedPaths);
  });

  it("onRuntimeCreated 在会话 / 场景 / ephemeral 三条发放路径都被调用", async () => {
    const { options, onRuntimeCreated } = makeHostOptions();
    const host = new RuntimeHost(options);

    const conv = await host.createConversationRuntime();
    const ws = await host.createWorksceneRuntime({
      scene: workscene("s1", "场景"),
      absolutePath: null,
    });
    const eph = await host.createEphemeralRuntime();

    expect(onRuntimeCreated).toHaveBeenCalledTimes(3);
    expect(onRuntimeCreated).toHaveBeenNthCalledWith(1, conv);
    expect(onRuntimeCreated).toHaveBeenNthCalledWith(2, ws);
    expect(onRuntimeCreated).toHaveBeenNthCalledWith(3, eph);
  });

  it("workscene 装配:只消费本机解析路径、无 workspace 显式 null，并绑定 power 角色与记忆域", async () => {
    const { options, assembled } = makeHostOptions();
    const host = new RuntimeHost(options);

    await host.createWorksceneRuntime({
      scene: workscene("s1", "场景", {
        workspace: { deviceId: "device-a", bindingRef: "binding-a" },
      }),
      absolutePath: "/proj",
    });
    let params = createAgentRuntimeMock.mock.calls[0]![0];
    expect(params.workspace).toBe("/proj");
    expect(params.runtimeKind).toBe("conversation");
    expect(params.primaryRole).toBe("power");
    expect(params.memoryScope).toEqual({ kind: "workscene", sceneId: "s1" });
    expect(params.profile).toBeDefined();
    expect((assembled[0] as { spec?: unknown }).spec).toEqual({
      kind: "workscene",
      sceneId: "s1",
      sceneName: "场景",
    });

    // 无 workspace → 显式 null（不回落 host 缺省，杜绝串到 cwd）
    await host.createWorksceneRuntime({
      scene: workscene("s2", "纯对话场景"),
      absolutePath: null,
    });
    params = createAgentRuntimeMock.mock.calls[1]![0];
    expect(params.workspace).toBeNull();
    expect(params.runtimeKind).toBe("conversation");
    expect(params.profile.enabledTools).not.toContain("read");
    expect(params.profile.enabledTools).not.toContain("admit_skill");
  });
});

function workscene(
  id: string,
  name: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    revision: 1,
    name,
    createdAt: "2026-07-30T00:00:00.000Z",
    lastActiveAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}
