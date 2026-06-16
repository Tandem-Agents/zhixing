/**
 * RuntimeHost 装配契约 —— 资产透传、两条发放路径、origin 执行期派生。
 *
 * 范围:锁 host 这一层"装配参数从哪来、origin 何时定"——
 *   - 资产层透传:skillStore / segmentDeps / decorateRunBus 按引用直达
 *     createAgentRuntime;extra tools 经 assembly 装配;main/ephemeral 工作区由
 *     createAgentRuntime 按配置解析,host 不持用户启动覆盖
 *   - 会话路径:scheduleOrigin 执行期从 RunContext 的 turnOrigin 派生
 *     (渠道入口带投递目标、本地对话与无上下文时 null),装配期不绑定对话
 *   - ephemeral 路径:origin 恒 null
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

const { RuntimeHost, resolveScheduleOriginFromTurnOrigin } = await import(
  "../runtime-host.js"
);
const { runContextStorage } = await import("@zhixing/orchestrator/runtime");

// ─── 测试辅助 ───

type AssembledCtx = {
  scheduler: () => unknown;
  scheduleOrigin?: () => unknown;
};

function makeHostOptions() {
  const assembled: AssembledCtx[] = [];
  const onRuntimeCreated = vi.fn();
  const skillStore = { marker: "skill-store" };
  const segmentDeps = { marker: "segment-deps" };
  const decorateRunBus = () => () => {};
  const tools = [{ name: "schedule" }];
  const options = {
    skillStore,
    segmentDeps,
    extraTools: {
      taskListService: {},
      mcpHub: {},
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

describe("resolveScheduleOriginFromTurnOrigin", () => {
  it("从 turnOrigin 读取投递目标;无来源目标返回 null", () => {
    expect(
      resolveScheduleOriginFromTurnOrigin({
        channel: "feishu",
        target: { channelId: "feishu", to: "ou_abc" },
        triggeredBy: "ou_abc",
      }),
    ).toEqual({
      channelId: "feishu",
      to: "ou_abc",
    });
    expect(resolveScheduleOriginFromTurnOrigin(undefined)).toBeNull();
    expect(
      resolveScheduleOriginFromTurnOrigin({ channel: "cli" }),
    ).toBeNull();
  });
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
  });

  it("onRuntimeCreated 在会话 / 场景 / ephemeral 三条发放路径都被调用", async () => {
    const { options, onRuntimeCreated } = makeHostOptions();
    const host = new RuntimeHost(options);

    const conv = await host.createConversationRuntime();
    const ws = await host.createWorksceneRuntime({
      id: "s1",
      name: "场景",
    } as never);
    const eph = await host.createEphemeralRuntime();

    expect(onRuntimeCreated).toHaveBeenCalledTimes(3);
    expect(onRuntimeCreated).toHaveBeenNthCalledWith(1, conv);
    expect(onRuntimeCreated).toHaveBeenNthCalledWith(2, ws);
    expect(onRuntimeCreated).toHaveBeenNthCalledWith(3, eph);
  });

  it("workscene 装配:workdir 为工作区(缺省显式 null)、power 角色与记忆域、spec 进工具装配", async () => {
    const { options, assembled } = makeHostOptions();
    const host = new RuntimeHost(options);

    await host.createWorksceneRuntime({
      id: "s1",
      name: "场景",
      workdir: "/proj",
    } as never);
    let params = createAgentRuntimeMock.mock.calls[0]![0];
    expect(params.workspace).toBe("/proj");
    expect(params.primaryRole).toBe("power");
    expect(params.memoryScope).toEqual({ kind: "workscene", sceneId: "s1" });
    expect(params.profile).toBeDefined();
    expect((assembled[0] as { spec?: { kind: string } }).spec).toEqual({
      kind: "workscene",
    });

    // 无 workdir → workspace 显式 null(不回落 host 缺省,杜绝串到 cwd)
    await host.createWorksceneRuntime({ id: "s2", name: "纯对话场景" } as never);
    params = createAgentRuntimeMock.mock.calls[1]![0];
    expect(params.workspace).toBeNull();
  });
});

describe("schedule origin 派生", () => {
  it("会话路径:执行期从 RunContext 读 turnOrigin——渠道入口出 origin、本地对话 null、无上下文 null", async () => {
    const { options, assembled } = makeHostOptions();
    const host = new RuntimeHost(options);
    await host.createConversationRuntime();
    const getOrigin = assembled[0]!.scheduleOrigin!;

    // 无 RunContext(装配期 / 测试裸调)→ null
    expect(getOrigin()).toBeNull();

    // 渠道入口 run 内 → 使用来源投递目标
    const bus = { on: vi.fn(), emit: vi.fn() } as never;
    runContextStorage.run(
      {
        bus,
        lineage: "main",
        conversationId: "default",
        turnOrigin: {
          channel: "feishu",
          target: { channelId: "feishu", to: "ou_x" },
          triggeredBy: "ou_x",
        },
      },
      () => {
        expect(getOrigin()).toEqual({ channelId: "feishu", to: "ou_x" });
      },
    );

    // 本地对话 run 内 → null
    runContextStorage.run(
      { bus, lineage: "main", conversationId: "default" },
      () => {
        expect(getOrigin()).toBeNull();
      },
    );
  });

  it("同一会话装配闭包服务不同来源——同实例在不同 RunContext 下派生不同 origin", async () => {
    const { options, assembled } = makeHostOptions();
    const host = new RuntimeHost(options);
    await host.createConversationRuntime();
    const getOrigin = assembled[0]!.scheduleOrigin!;
    const bus = { on: vi.fn(), emit: vi.fn() } as never;

    runContextStorage.run(
      {
        bus,
        lineage: "main",
        conversationId: "default",
        turnOrigin: {
          channel: "feishu",
          target: { channelId: "feishu", to: "ou_a" },
          triggeredBy: "ou_a",
        },
      },
      () => expect(getOrigin()).toEqual({ channelId: "feishu", to: "ou_a" }),
    );
    runContextStorage.run(
      {
        bus,
        lineage: "main",
        conversationId: "default",
        turnOrigin: {
          channel: "feishu",
          target: { channelId: "feishu", to: "ou_b" },
          triggeredBy: "ou_b",
        },
      },
      () => expect(getOrigin()).toEqual({ channelId: "feishu", to: "ou_b" }),
    );
  });

  it("ephemeral 路径:origin 恒 null(任一 RunContext 下都不派生)", async () => {
    const { options, assembled } = makeHostOptions();
    const host = new RuntimeHost(options);
    await host.createEphemeralRuntime();
    const getOrigin = assembled[0]!.scheduleOrigin!;
    const bus = { on: vi.fn(), emit: vi.fn() } as never;

    expect(getOrigin()).toBeNull();
    runContextStorage.run(
      {
        bus,
        lineage: "main",
        conversationId: "default",
        turnOrigin: {
          channel: "feishu",
          target: { channelId: "feishu", to: "ou_x" },
          triggeredBy: "ou_x",
        },
      },
      () => {
        expect(getOrigin()).toBeNull();
      },
    );
  });
});
