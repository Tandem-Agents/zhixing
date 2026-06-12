/**
 * RuntimeHost 装配契约 —— 资产透传、两条发放路径、origin 执行期派生。
 *
 * 范围:锁 host 这一层"装配参数从哪来、origin 何时定"——
 *   - 资产层透传:skillStore / segmentDeps / decorateRunBus / workspace 按引用直达
 *     createAgentRuntime;extra tools 经 assembly 装配
 *   - 会话路径:scheduleOrigin 执行期从 RunContext 的 conversationId 派生
 *     (渠道会话解析出投递目标、本地对话与无上下文时 null),装配期不绑定对话
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

const { RuntimeHost, parseOriginFromConversationId } = await import(
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
    workspace: "/ws",
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

describe("parseOriginFromConversationId", () => {
  it("渠道会话 id 解析出投递目标;本地对话与异形 id 返回 null", () => {
    expect(parseOriginFromConversationId("dm:feishu:ou_abc")).toEqual({
      channelId: "feishu",
      to: "ou_abc",
    });
    // to 段含冒号时整段保留
    expect(parseOriginFromConversationId("dm:feishu:a:b")).toEqual({
      channelId: "feishu",
      to: "a:b",
    });
    expect(parseOriginFromConversationId("conv_123")).toBeNull();
    expect(parseOriginFromConversationId("dm:feishu")).toBeNull();
  });
});

describe("资产层透传", () => {
  it("skillStore / segmentDeps / decorateRunBus / workspace 按引用直达装配", async () => {
    const { options, skillStore, segmentDeps, decorateRunBus, tools } =
      makeHostOptions();
    const host = new RuntimeHost(options);

    await host.createConversationRuntime();

    const params = createAgentRuntimeMock.mock.calls[0]![0];
    expect(params.skillStore).toBe(skillStore);
    expect(params.segmentDeps).toBe(segmentDeps);
    expect(params.decorateRunBus).toBe(decorateRunBus);
    expect(params.workspace).toBe("/ws");
    expect(params.extraTools).toBe(tools);
  });

  it("onRuntimeCreated 在会话与 ephemeral 两条发放路径都被调用", async () => {
    const { options, onRuntimeCreated } = makeHostOptions();
    const host = new RuntimeHost(options);

    const conv = await host.createConversationRuntime();
    const eph = await host.createEphemeralRuntime();

    expect(onRuntimeCreated).toHaveBeenCalledTimes(2);
    expect(onRuntimeCreated).toHaveBeenNthCalledWith(1, conv);
    expect(onRuntimeCreated).toHaveBeenNthCalledWith(2, eph);
  });
});

describe("schedule origin 派生", () => {
  it("会话路径:执行期从 RunContext 读 conversationId——渠道会话出 origin、本地对话 null、无上下文 null", async () => {
    const { options, assembled } = makeHostOptions();
    const host = new RuntimeHost(options);
    await host.createConversationRuntime();
    const getOrigin = assembled[0]!.scheduleOrigin!;

    // 无 RunContext(装配期 / 测试裸调)→ null
    expect(getOrigin()).toBeNull();

    // 渠道会话 run 内 → 解析出投递目标
    const bus = { on: vi.fn(), emit: vi.fn() } as never;
    runContextStorage.run(
      { bus, lineage: "main", conversationId: "dm:feishu:ou_x" },
      () => {
        expect(getOrigin()).toEqual({ channelId: "feishu", to: "ou_x" });
      },
    );

    // 本地对话 run 内 → null
    runContextStorage.run(
      { bus, lineage: "main", conversationId: "conv_local" },
      () => {
        expect(getOrigin()).toBeNull();
      },
    );
  });

  it("同一会话装配闭包服务不同对话——同实例在不同 RunContext 下派生不同 origin", async () => {
    const { options, assembled } = makeHostOptions();
    const host = new RuntimeHost(options);
    await host.createConversationRuntime();
    const getOrigin = assembled[0]!.scheduleOrigin!;
    const bus = { on: vi.fn(), emit: vi.fn() } as never;

    runContextStorage.run(
      { bus, lineage: "main", conversationId: "dm:feishu:ou_a" },
      () => expect(getOrigin()).toEqual({ channelId: "feishu", to: "ou_a" }),
    );
    runContextStorage.run(
      { bus, lineage: "main", conversationId: "dm:feishu:ou_b" },
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
      { bus, lineage: "main", conversationId: "dm:feishu:ou_x" },
      () => {
        expect(getOrigin()).toBeNull();
      },
    );
  });
});
