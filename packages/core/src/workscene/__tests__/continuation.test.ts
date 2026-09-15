import { describe, expect, it, vi } from "vitest";
import {
  WorksceneContinuationApplication,
  hasPendingWorksceneTask,
  validateWorksceneControl,
  validateWorksceneContinuationCommit,
  worksceneTaskContext,
  readWorksceneTaskContext,
  validateWorksceneTaskHandoff,
  worksceneContinuationTurnId,
  type WorksceneContinuationPort,
  type WorksceneContinuationSource,
} from "../continuation.js";

const handoff = {
  goal: "交付报告",
  constraints: ["不发布"],
  completed: ["已取得获准数据"],
  remaining: ["核实并整理结论"],
};

describe("workscene assignment-bound facts", () => {
  const target = { conversationId: "main-1", runId: "run-1" };
  const origin = { kind: "result" as const, ...target };
  const work = {
    ingress: {
      turnOrigin: { channel: "rpc" as const, worksceneContinuation: origin },
    },
    controlContext: worksceneTaskContext([{ ...target, goal: "交付报告" }]),
  } as Parameters<typeof validateWorksceneContinuationCommit>[1];
  it("round-trips task references and validates origin and stop proposals against their assignment", () => {
    expect(readWorksceneTaskContext(work.controlContext)).toEqual([
      { ...target, goal: "交付报告" },
    ]);
    const record = {
      worksceneContinuation: origin,
      postTurnControl: {
        intent: { kind: "stop_task" as const, ...target },
        stops: [target],
      },
    };
    expect(() =>
      validateWorksceneContinuationCommit(record, work),
    ).not.toThrow();
    expect(() =>
      validateWorksceneContinuationCommit(
        { ...record, worksceneContinuation: { ...origin, runId: "forged" } },
        work,
      ),
    ).toThrow(/origin/);
    expect(() =>
      validateWorksceneContinuationCommit(record, {
        ...work,
        controlContext: [],
      }),
    ).toThrow(/not issued/);
    expect(() =>
      validateWorksceneContinuationCommit({}, { ...work, controlContext: [] }),
    ).not.toThrow();
  });
});
function original(
  overrides: Partial<WorksceneContinuationSource> = {},
): WorksceneContinuationSource {
  return {
    conversationId: "main-1",
    runId: "run-1",
    ingressId: "turn-1",
    state: "committed",
    current: true,
    result: "开始委派",
    surfacePrincipal: "owner",
    origin: {
      channel: "feishu",
      target: { channelId: "feishu", to: "chat-1" },
    },
    control: { intent: { kind: "enter", sceneId: "reports", handoff } },
    ...overrides,
  };
}
function fixture(sources: WorksceneContinuationSource[]) {
  const claims = new Map<string, "open" | "closed">();
  const port: WorksceneContinuationPort = {
    read: vi.fn(async (id) =>
      sources.filter((source) => source.conversationId === id),
    ),
    inspect: vi.fn(
      async (id, turn) => claims.get(`${id}/${turn}`) ?? "missing",
    ),
    enter: vi.fn(async () => {}),
    hasActiveAdvancement: vi.fn(async () => false),
    workspaceMatches: vi.fn(async () => true),
    cancelAdvancement: vi.fn(async () => {}),
    admit: vi.fn(async (request) => {
      claims.set(`${request.conversationId}/${request.turnId}`, "open");
    }),
    cancel: vi.fn(async (id, turn) => {
      claims.set(`${id}/${turn}`, "closed");
    }),
    stop: vi.fn(async (id, runId) => {
      const index = sources.findIndex(
        (item) => item.conversationId === id && item.runId === runId,
      );
      if (index >= 0) sources[index] = { ...sources[index]!, current: false };
    }),
  };
  return {
    sources,
    claims,
    port,
    app: new WorksceneContinuationApplication(port),
  };
}
function child(
  parent: WorksceneContinuationSource,
  overrides: Partial<WorksceneContinuationSource> = {},
): WorksceneContinuationSource {
  return original({
    conversationId: "ws:reports:primary",
    runId: "child-1",
    control: undefined,
    result: "报告已生成，尚未发布",
    origin: {
      ...parent.origin!,
      worksceneContinuation: {
        kind: "task",
        conversationId: parent.conversationId,
        runId: parent.runId,
        returnConversationId: parent.conversationId,
      },
    },
    ...overrides,
  });
}

describe("Workscene durable task continuation", () => {
  it.each([
    "mismatch",
    "rejected",
  ])("returns nested workspace failure to the original acceptance exactly once: %s", async (failure) => {
    const root = original({
      advancement: { sessionId: "adv-1", proxyMessageId: "proxy-1" },
    });
    const nested = child(root, {
      control: {
        intent: {
          kind: "set_workdir",
          sceneId: "reports",
          workspace: null,
          handoff,
        },
      },
    });
    const f = fixture([root, nested]);
    if (failure === "mismatch")
      vi.mocked(f.port.workspaceMatches).mockResolvedValue(false);
    else
      vi.mocked(f.port.admit).mockImplementationOnce(async () => ({
        rejected: "目标已关闭",
      }));
    await f.app.recover(nested.conversationId);
    await f.app.recover(nested.conversationId);
    const returns = vi
      .mocked(f.port.admit)
      .mock.calls.map(([input]) => input)
      .filter((input) => input.conversationId === root.conversationId);
    expect(returns).toHaveLength(1);
    expect(returns[0]?.advancement).toEqual(root.advancement);
    expect(returns[0]?.origin.worksceneContinuation?.kind).toBe("result");
  });

  it("lists entrusted work from lineage, stops only the selected root and keeps stop before replacement", async () => {
    const first = original();
    const second = original({
      runId: "other-task",
      control: {
        intent: {
          kind: "enter",
          sceneId: "another",
          handoff: { ...handoff, goal: "另一个报告" },
        },
      },
    });
    const replacement = original({
      runId: "replacement",
      control: {
        intent: { kind: "enter", sceneId: "new-scene", handoff },
        stops: [{ conversationId: first.conversationId, runId: first.runId }],
      },
    });
    const f = fixture([first, second]);
    expect(await f.app.tasks("main-1")).toHaveLength(2);
    f.sources.push(replacement);
    await f.app.recover("main-1");
    expect(f.port.stop).toHaveBeenCalledOnce();
    expect(
      vi.mocked(f.port.admit).mock.calls.map(([input]) => input.conversationId),
    ).toEqual(["ws:another:primary", "ws:new-scene:primary"]);
    await expect(
      f.app.stop({
        conversationId: "main-1",
        target: { conversationId: "unrelated", runId: "foreign" },
        requestId: "invalid",
      }),
    ).rejects.toThrow("不属于");
  });
  it("does not start work for navigation or an empty remaining list", async () => {
    const f = fixture([
      original({ control: { intent: { kind: "enter", sceneId: "reports" } } }),
    ]);
    await f.app.recover("main-1");
    f.sources[0] = original({
      control: {
        intent: {
          kind: "enter",
          sceneId: "reports",
          handoff: { ...handoff, remaining: [] },
        },
      },
    });
    await f.app.recover("main-1");
    expect(f.port.admit).not.toHaveBeenCalled();
    expect(f.port.enter).not.toHaveBeenCalled();
  });

  it("hands off only approved input and preserves the reply route and principal", async () => {
    const f = fixture([original()]);
    await f.app.recover("main-1");
    const input = vi.mocked(f.port.admit).mock.calls[0]![0];
    expect(input).toMatchObject({
      conversationId: "ws:reports:primary",
      surfacePrincipal: "owner",
      origin: {
        channel: "feishu",
        target: original().origin!.target,
        worksceneContinuation: {
          kind: "task",
          conversationId: "main-1",
          runId: "run-1",
          returnConversationId: "main-1",
        },
      },
    });
    expect(input.input).toContain(JSON.stringify(handoff));
    expect(input.input).not.toContain("开始委派");
  });

  it("replays the same claim after restart without another task or entry", async () => {
    const f = fixture([original()]);
    await Promise.all([f.app.recover("main-1"), f.app.recover("main-1")]);
    f.claims.set(
      `ws:reports:primary/${worksceneContinuationTurnId(original())}`,
      "closed",
    );
    await new WorksceneContinuationApplication(f.port).recover("main-1");
    expect(f.port.admit).toHaveBeenCalledTimes(1);
    expect(f.port.enter).toHaveBeenCalledTimes(1);
  });

  it("does not admit when the user changes their mind during entry", async () => {
    const f = fixture([original()]);
    vi.mocked(f.port.enter).mockImplementationOnce(async () => {
      f.sources[0] = original({ current: false });
    });
    await f.app.recover("main-1");
    expect(f.port.admit).not.toHaveBeenCalled();
  });

  it("cancels accepted work if its source is revoked during admission or recovery", async () => {
    const f = fixture([original()]);
    vi.mocked(f.port.admit).mockImplementationOnce(async () => {
      f.sources[0] = original({ current: false });
    });
    await f.app.recover("main-1");
    expect(f.port.cancel).toHaveBeenCalledWith(
      "ws:reports:primary",
      worksceneContinuationTurnId(original()),
    );
    vi.mocked(f.port.inspect).mockResolvedValue("open");
    await f.app.recover("main-1");
    expect(f.port.cancel).toHaveBeenCalledTimes(2);
  });

  it("returns entry failure once rather than abandoning the original task", async () => {
    const f = fixture([original()]);
    vi.mocked(f.port.enter).mockRejectedValue(new Error("场景已被删除"));
    await f.app.recover("main-1");
    await new WorksceneContinuationApplication(f.port).recover("main-1");
    expect(f.port.admit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.port.admit).mock.calls[0]![0]).toMatchObject({
      conversationId: "main-1",
      origin: { worksceneContinuation: { kind: "result" } },
    });
    expect(vi.mocked(f.port.admit).mock.calls[0]![0].input).toContain(
      "场景已被删除",
    );
  });

  it("returns a definitive admission rejection but retries uncertain transport with the same identity", async () => {
    const f = fixture([original()]);
    vi.mocked(f.port.admit).mockResolvedValueOnce({ rejected: "场景已删除" });
    await f.app.recover("main-1");
    expect(vi.mocked(f.port.admit).mock.calls[1]![0].input).toContain(
      "场景已删除",
    );
    const g = fixture([original()]);
    vi.mocked(g.port.admit).mockRejectedValueOnce(new Error("响应丢失"));
    await expect(g.app.recover("main-1")).rejects.toThrow("响应丢失");
    await g.app.recover("main-1");
    expect(vi.mocked(g.port.admit).mock.calls[0]![0]).toEqual(
      vi.mocked(g.port.admit).mock.calls[1]![0],
    );
  });

  it("does not mix a handoff into another independent acceptance task", async () => {
    const f = fixture([original()]);
    vi.mocked(f.port.hasActiveAdvancement).mockResolvedValue(true);
    await f.app.recover("main-1");
    expect(f.port.enter).not.toHaveBeenCalled();
    expect(vi.mocked(f.port.admit).mock.calls[0]![0]).toMatchObject({
      conversationId: "main-1",
    });
    expect(vi.mocked(f.port.admit).mock.calls[0]![0].input).toContain(
      "独立验收中的任务",
    );
  });

  it("returns child results to the original conversation with its independent review identity", async () => {
    const parent = original({
      advancement: { sessionId: "adv-1", proxyMessageId: "proxy-1" },
    });
    const f = fixture([parent, child(parent)]);
    await f.app.recover("ws:reports:primary");
    await f.app.recover("ws:reports:primary");
    expect(f.port.admit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.port.admit).mock.calls[0]![0]).toMatchObject({
      conversationId: "main-1",
      advancement: parent.advancement,
      origin: {
        worksceneContinuation: {
          kind: "result",
          conversationId: "ws:reports:primary",
          runId: "child-1",
        },
      },
    });
    expect(vi.mocked(f.port.admit).mock.calls[0]![0].input).toContain(
      "报告已生成，尚未发布",
    );
  });

  it("does not return late output to a superseded original task", async () => {
    const parent = original({ current: false });
    const f = fixture([parent, child(parent)]);
    await f.app.recover("ws:reports:primary");
    expect(f.port.admit).not.toHaveBeenCalled();
  });

  it("returns known failure, leaves uncertain effects for resolution, and stops cancelled Advancement", async () => {
    const parent = original({ advancementSessionId: "adv-1" });
    const f = fixture([
      parent,
      child(parent, { state: "failed", result: "运行失败，副作用需核对" }),
    ]);
    await f.app.recover("ws:reports:primary");
    expect(vi.mocked(f.port.admit).mock.calls[0]![0].input).toContain(
      "副作用需核对",
    );
    vi.mocked(f.port.admit).mockClear();
    f.sources[1] = child(parent, { state: "uncertain" });
    await f.app.recover("ws:reports:primary");
    expect(f.port.admit).not.toHaveBeenCalled();
    f.sources[1] = child(parent, { state: "cancelled" });
    await f.app.recover("ws:reports:primary");
    expect(f.port.cancelAdvancement).toHaveBeenCalledWith("main-1", "adv-1");
    expect(f.port.admit).not.toHaveBeenCalled();
  });

  it("continues after a committed workspace change without rewriting it or making a result loop", async () => {
    const source = original({
      conversationId: "ws:reports:primary",
      control: {
        intent: {
          kind: "set_workdir",
          sceneId: "reports",
          workspace: null,
          handoff,
        },
      },
    });
    const f = fixture([source]);
    await f.app.recover(source.conversationId);
    const request = vi.mocked(f.port.admit).mock.calls[0]![0];
    expect(request.origin.worksceneContinuation?.kind).toBe("resume");
    expect(f.port.workspaceMatches).toHaveBeenCalledWith("reports", null);
    expect(f.port.enter).not.toHaveBeenCalled();
    f.sources.push(child(source, { runId: "resumed", origin: request.origin }));
    await f.app.recover(source.conversationId);
    expect(f.port.admit).toHaveBeenCalledTimes(1);
  });

  it("returns nested workspace continuation to the root task, not a self-loop", async () => {
    const parent = original();
    const first = child(parent, {
      control: {
        intent: {
          kind: "set_workdir",
          sceneId: "reports",
          workspace: null,
          handoff,
        },
      },
    });
    const f = fixture([parent, first]);
    await f.app.recover(first.conversationId);
    f.sources.push(
      child(first, {
        runId: "resumed",
        origin: vi.mocked(f.port.admit).mock.calls[0]![0].origin,
      }),
    );
    await f.app.recover(first.conversationId);
    expect(vi.mocked(f.port.admit).mock.calls[1]![0].conversationId).toBe(
      "main-1",
    );
  });

  it("reports an unapplied workspace change instead of running in another environment", async () => {
    const source = original({
      conversationId: "ws:reports:primary",
      control: {
        intent: {
          kind: "set_workdir",
          sceneId: "reports",
          workspace: null,
          handoff,
        },
      },
    });
    const f = fixture([source]);
    vi.mocked(f.port.workspaceMatches).mockResolvedValue(false);
    await f.app.recover(source.conversationId);
    expect(vi.mocked(f.port.admit).mock.calls[0]![0].input).toContain("未生效");
  });

  it("exit with remaining work is a result continuation, not a round trip", async () => {
    const parent = original();
    const f = fixture([
      parent,
      child(parent, { control: { intent: { kind: "exit", handoff } } }),
    ]);
    await f.app.recover("ws:reports:primary");
    const request = vi.mocked(f.port.admit).mock.calls[0]![0];
    expect(request.conversationId).toBe("main-1");
    expect(request.origin.worksceneContinuation?.kind).toBe("result");
    f.sources.push(
      original({
        runId: "returned",
        control: undefined,
        origin: request.origin,
      }),
    );
    await f.app.recover("main-1");
    expect(
      vi
        .mocked(f.port.admit)
        .mock.calls.filter(([r]) => r.turnId.endsWith(":result")),
    ).toHaveLength(0);
  });
});

describe("handoff contract", () => {
  it.each([
    "direct",
    "committed-proposal",
  ])("stops the issued root after returning and redelegating: %s", async (mode) => {
    const root = original();
    const first = child(root);
    const returned = original({
      runId: "returned",
      origin: {
        channel: "rpc",
        worksceneContinuation: {
          kind: "result",
          conversationId: first.conversationId,
          runId: first.runId,
        },
      },
      control: { intent: { kind: "enter", sceneId: "second", handoff } },
    });
    const second = child(returned, {
      conversationId: "ws:second:primary",
      runId: "second-child",
      ingressId: "second-turn",
      state: "running",
    });
    const unrelated = original({
      conversationId: "other-main",
      runId: "other-root",
    });
    const f = fixture([root, first, returned, second, unrelated]);
    const target = (await f.app.tasks(second.conversationId))[0]!;
    expect(target).toMatchObject({
      conversationId: root.conversationId,
      runId: root.runId,
    });
    if (mode === "committed-proposal") {
      f.sources.push(
        original({
          conversationId: second.conversationId,
          runId: "stop-proposer",
          control: {
            intent: {
              kind: "stop_task",
              conversationId: target.conversationId,
              runId: target.runId,
            },
            stops: [
              { conversationId: target.conversationId, runId: target.runId },
            ],
          },
        }),
      );
      await f.app.recover(second.conversationId);
    } else
      await f.app.stop({
        conversationId: second.conversationId,
        target,
        requestId: "stop-root",
      });
    expect(f.port.stop).toHaveBeenCalledWith(
      root.conversationId,
      root.runId,
      expect.any(String),
    );
    const reloaded = new WorksceneContinuationApplication(f.port);
    await reloaded.stop({
      conversationId: second.conversationId,
      target,
      requestId: "stop-root",
    });
    await reloaded.stop({
      conversationId: root.conversationId,
      target,
      requestId: "stop-root",
    });
    expect(await reloaded.tasks(second.conversationId)).toEqual([]);
    expect(
      f.sources.find((item) => item.runId === unrelated.runId)?.current,
    ).toBe(true);
    await expect(
      reloaded.stop({
        conversationId: second.conversationId,
        target: unrelated,
        requestId: "wrong-root",
      }),
    ).rejects.toThrow("不属于");
  });
  it("validates bounded approved fields and the committed control", () => {
    expect(() => validateWorksceneControl(original().control)).not.toThrow();
    expect(
      hasPendingWorksceneTask({ postTurnControl: original().control }),
    ).toBe(true);
    for (const invalid of [
      { ...handoff, privateHistory: "extra" },
      { ...handoff, goal: "" },
      { ...handoff, remaining: [null] },
      { ...handoff, completed: Array(10).fill("x".repeat(4_000)) },
    ]) {
      expect(() => validateWorksceneTaskHandoff(invalid)).toThrow();
    }
    for (const invalid of [
      { intent: { kind: "unknown" } },
      { intent: { kind: "enter", sceneId: "../private" } },
      {
        intent: {
          kind: "set_workdir",
          sceneId: "reports",
          workspace: { path: "/private" },
        },
      },
    ])
      expect(() => validateWorksceneControl(invalid)).toThrow();
  });
});
