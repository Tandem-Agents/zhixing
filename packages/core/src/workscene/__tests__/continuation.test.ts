import { describe, expect, it, vi } from "vitest";
import { McpConnectionApplication } from "../../mcp-management/application.js";
import {
  WorksceneContinuationApplication,
  worksceneContinuationTarget,
  isWorksceneSupportConversation,
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
    canRunIsolatedMain: () => true,
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
  it("returns unavailable isolated execution once and preserves the original acceptance", async () => {
    const root = original({ conversationId: "ws:reports:primary", control: { intent: { kind: "exit", handoff } }, advancement: { sessionId: "adv-original", proxyMessageId: "proxy-original" } });
    const f = fixture([root]);
    f.port.canRunIsolatedMain = () => false;
    await f.app.recover(root.conversationId);
    await new WorksceneContinuationApplication(f.port).recover(root.conversationId);
    expect(f.port.admit).toHaveBeenCalledTimes(1);
    const request = vi.mocked(f.port.admit).mock.calls[0]![0];
    expect(request).toMatchObject({ conversationId: root.conversationId, advancement: root.advancement, origin: { worksceneContinuation: { kind: "result" } } });
    expect(request.input).toContain("未启用本机执行器");
    expect(request.input).toContain("组合现有工具");
    expect([...f.claims.keys()].some((key) => key.startsWith("workscene-support-"))).toBe(false);
  });
  it("derives interaction visibility only from a live issued child and its current ancestors", async () => {
    const root = original({ conversationId: "ws:reports:primary", control: { intent: { kind: "exit", handoff } } });
    const f = fixture([root]);
    await f.app.recover(root.conversationId);
    const request = vi.mocked(f.port.admit).mock.calls[0]![0];
    const active = original({ conversationId: request.conversationId, runId: "support", state: "running", origin: request.origin });
    f.sources.push(active);
    expect(await f.app.interactionSource(request.conversationId, request.origin)).toEqual({ conversationId: root.conversationId, surfacePrincipal: "owner" });
    expect(await f.app.interactionSource(request.conversationId, { ...request.origin, worksceneContinuation: { ...request.origin.worksceneContinuation!, returnConversationId: "private-other" } })).toBeUndefined();
    f.sources[0] = { ...root, current: false };
    expect(await f.app.interactionSource(request.conversationId, request.origin)).toBeUndefined();
    f.sources[0] = root;
    f.sources[1] = { ...active, surfacePrincipal: "other" };
    expect(await f.app.interactionSource(request.conversationId, request.origin)).toBeUndefined();
  });
  it("does not restart an active connection if continuation admission was interrupted", async () => {
    const candidate = { serverId: "demo", source: "inferred" as const, entry: { command: "node" }, secretFields: [] };
    const root = original({ control: { intent: { kind: "connect_mcp", candidate, scope: { deviceId: "anchor", configurationRevision: "v1" }, handoff } } });
    const f = fixture([root]); let configured = false; let active = false;
    const activate = vi.fn(async () => { active = true; return true; });
    const infrastructure = { inspect: async () => ({ conflict: false, credentialsReady: true, configured, active }), commit: async () => { configured = true; return "added" as const; }, activate };
    let connection = new McpConnectionApplication(infrastructure);
    f.port.connectMcp = (proposal, _source, scope) => connection.connect(proposal, undefined, undefined, scope);
    const admit = f.port.admit;
    f.port.admit = vi.fn().mockRejectedValueOnce(new Error("admission interrupted")).mockImplementation(admit);
    await expect(f.app.recover(root.conversationId)).rejects.toThrow("admission interrupted");
    expect(configured).toBe(true); expect(active).toBe(true); expect(f.claims.size).toBe(0);
    connection = new McpConnectionApplication(infrastructure);
    await new WorksceneContinuationApplication(f.port).recover(root.conversationId);
    await f.app.recover(root.conversationId);
    expect(activate).toHaveBeenCalledTimes(1); expect(f.claims.size).toBe(1);
  });
  it("delegates a directly started scene to an isolated main and returns after controlled connection", async () => {
    const root = original({ conversationId: "ws:reports:primary", control: { intent: { kind: "exit", handoff } }, advancement: { sessionId: "adv-original", proxyMessageId: "proxy-original" } });
    const f = fixture([root]);
    const target = worksceneContinuationTarget(root)!;
    expect(isWorksceneSupportConversation(target)).toBe(true);
    expect(worksceneContinuationTarget(structuredClone(root))).toBe(target);
    expect(worksceneContinuationTarget({ ...root, runId: "other-run" })).not.toBe(target);
    await f.app.recover(root.conversationId);
    const request = vi.mocked(f.port.admit).mock.calls[0]![0];
    expect(request).toMatchObject({ conversationId: target, origin: { worksceneContinuation: { kind: "task", conversationId: root.conversationId, runId: root.runId, returnConversationId: root.conversationId } } });
    expect(request.advancement).toBeUndefined();
    expect(request.input).toContain(handoff.goal);
    const candidate = { serverId: "demo", source: "inferred" as const, entry: { command: "node" }, secretFields: [] };
    const connecting = original({ conversationId: target, runId: "support-1", origin: request.origin, control: { intent: { kind: "connect_mcp", candidate, scope: { deviceId: "anchor", configurationRevision: "v1" }, handoff } } });
    f.sources.push(connecting);
    f.port.connectMcp = vi.fn().mockResolvedValueOnce({ status: "needs-credentials", candidate }).mockResolvedValue({ status: "active", serverId: "demo" });
    f.port.pendingMcpStatus = async () => "needs-credentials";
    await f.app.recover(target);
    expect(await f.app.pendingMcpConnections(root.conversationId, "anchor")).toEqual([{ candidate, goal: handoff.goal, deviceId: "anchor", status: "needs-credentials" }]);
    expect(f.port.admit).toHaveBeenCalledTimes(1);
    await new WorksceneContinuationApplication(f.port).recover(target);
    const resumed = vi.mocked(f.port.admit).mock.calls[1]![0];
    expect(resumed.conversationId).toBe(target);
    f.sources.push(original({ conversationId: target, runId: "support-2", origin: resumed.origin, control: undefined, result: "已用 Anchor 的服务核实，回原场景生成报告" }));
    await new WorksceneContinuationApplication(f.port).recover(target);
    const returned = vi.mocked(f.port.admit).mock.calls[2]![0];
    expect(returned).toMatchObject({ conversationId: root.conversationId, advancement: root.advancement });
    expect(returned.input).toContain("回原场景生成报告");
    await f.app.recover(root.conversationId); await f.app.recover(target);
    expect(f.port.admit).toHaveBeenCalledTimes(3);
  });
  it("does not create isolated work from a cancelled source or return it after source revocation", async () => {
    const root = original({ conversationId: "ws:reports:primary", current: false, control: { intent: { kind: "exit", handoff } } });
    const f = fixture([root]);
    await f.app.recover(root.conversationId);
    expect(f.port.admit).not.toHaveBeenCalled();
    const delegated = child(root, { conversationId: worksceneContinuationTarget(root)!, control: undefined });
    f.sources.push(delegated);
    await f.app.recover(delegated.conversationId);
    expect(f.port.admit).not.toHaveBeenCalled();
  });
  it("projects pending credentials only along the current task lineage and requested device", async () => {
    const root = original();
    const candidate = { serverId: "demo", source: "inferred" as const, entry: { command: "node" }, secretFields: [] };
    const intent = { kind: "connect_mcp" as const, candidate, scope: { deviceId: "local", configurationRevision: "v1" }, handoff };
    const nested = child(root, { control: { intent } });
    const unrelated = child(original({ runId: "another-task" }), { runId: "unrelated", control: { intent: { ...intent, candidate: { ...candidate, serverId: "other" } } } });
    const f = fixture([root, nested, unrelated]);
    expect(await f.app.pendingMcpConnections(root.conversationId, "local")).toEqual([{ candidate, goal: handoff.goal, deviceId: "local", status: "pending" }]);
    expect(await f.app.pendingMcpConnections(root.conversationId, "other-device")).toEqual([]);
  });
  it("waits for MCP credentials, then resumes exactly once with original goal and acceptance", async () => {
    const candidate = { serverId: "demo", source: "inferred" as const, entry: { command: "node" }, secretFields: [] };
    const source = original({ control: { intent: { kind: "connect_mcp", candidate, scope: { deviceId: "local", configurationRevision: "v1" }, handoff } }, advancement: { sessionId: "adv-1", proxyMessageId: "proxy-1" } });
    const f = fixture([source]);
    f.port.connectMcp = vi.fn().mockResolvedValueOnce({ status: "needs-credentials", candidate }).mockResolvedValue({ status: "active", serverId: "demo" });
    await f.app.recover(source.conversationId);
    expect(f.port.admit).not.toHaveBeenCalled();
    expect(await f.app.pendingMcpConnections(source.conversationId)).toEqual([{ candidate, goal: handoff.goal, deviceId: "local", status: "pending" }]);
    await f.app.recover(source.conversationId);
    await f.app.recover(source.conversationId);
    expect(f.port.connectMcp).toHaveBeenCalledTimes(2);
    expect(f.port.admit).toHaveBeenCalledTimes(1);
    expect(f.port.admit).toHaveBeenCalledWith(expect.objectContaining({ conversationId: source.conversationId, advancement: source.advancement, input: expect.stringContaining(handoff.goal) }));
    expect(await f.app.pendingMcpConnections(source.conversationId)).toEqual([]);
  });

  it("returns a failed nested MCP connection to the original task and does not install again", async () => {
    const root = original();
    const candidate = { serverId: "demo", source: "inferred" as const, entry: { command: "node" }, secretFields: [] };
    const nested = child(root, { control: { intent: { kind: "connect_mcp", candidate, scope: { deviceId: "remote", configurationRevision: "v1" }, handoff } } });
    const f = fixture([root, nested]);
    f.port.connectMcp = vi.fn(async () => ({ status: "failed", message: "运行设备不匹配" }));
    await f.app.recover(nested.conversationId);
    await f.app.recover(nested.conversationId);
    expect(f.port.connectMcp).toHaveBeenCalledTimes(1);
    expect(f.port.admit).toHaveBeenCalledWith(expect.objectContaining({ conversationId: root.conversationId, input: expect.stringContaining("运行设备不匹配") }));
    expect(await f.app.pendingMcpConnections(nested.conversationId)).toEqual([]);
  });

  it("does not connect MCP from stopped or unsuccessful source runs", async () => {
    for (const state of ["cancelled", "failed", "running", "uncertain"] as const) {
      const candidate = { serverId: "demo", source: "inferred" as const, entry: { command: "node" }, secretFields: [] };
      const source = original({ state, control: { intent: { kind: "connect_mcp", candidate, scope: { deviceId: "local", configurationRevision: "v1" }, handoff } } });
      const f = fixture([source]);
      f.port.connectMcp = vi.fn();
      await f.app.recover(source.conversationId);
      expect(f.port.connectMcp).not.toHaveBeenCalled();
    }
  });
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
