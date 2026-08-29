import { describe, expect, it, vi } from "vitest";
import type { WorksceneDto } from "@zhixing/core/contracts";
import {
  createWorksceneConversationRuntimeFactory,
  createAnchorRuntimeProjectionAssembly,
} from "../workscene-runtime-projection.js";

function scene(
  overrides: Partial<WorksceneDto> = {},
): WorksceneDto {
  return {
    id: "scene-1",
    revision: 1,
    name: "写作场景",
    createdAt: "2026-08-29T00:00:00.000Z",
    lastActiveAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}

function fixture() {
  const workscenes = {} as never;
  const extraTools = {
    taskListService: {},
    mcpHub: {
      catalog: () => [
        { server: { serverId: "beta" }, tools: [] },
        { server: { serverId: "alpha" }, tools: [] },
      ],
    },
    assembleTools: () => [
      { name: "schedule" },
      { name: "task_list" },
      { name: "mcp__alpha__tool" },
    ],
  } as never;
  return createAnchorRuntimeProjectionAssembly({
    workscenes,
    extraTools,
    scheduler: () => ({}) as never,
  });
}

describe("Workscene product runtime projection", () => {
  it("forms frozen main and scene projections with the exact product tool split", () => {
    const assembly = fixture();
    const main = assembly.main();
    const withWorkspace = assembly.scene({
      scene: scene(),
      absolutePath: "/workspace",
    });
    const withoutWorkspace = assembly.scene({
      scene: scene({ id: "scene-2", name: "纯对话场景" }),
      absolutePath: null,
    });

    expect(Object.isFrozen(main)).toBe(true);
    expect(Object.isFrozen(withWorkspace.profile)).toBe(true);
    expect(main.runtimeTools.extraTools.map((tool) => tool.name).sort()).toEqual([
      "mcp__alpha__tool",
      "schedule",
      "task_list",
      "workmode_enter",
      "workscene_change_approve",
      "workscene_list",
    ]);
    expect(withWorkspace.runtimeTools.extraTools.map((tool) => tool.name).sort()).toEqual([
      "mcp__alpha__tool",
      "schedule",
      "task_list",
      "workmode_exit",
      "workscene_clear_workdir_current",
      "workscene_rename_current",
      "workscene_set_workdir_current",
    ]);
    expect(withWorkspace.workspace).toBe("/workspace");
    expect(withWorkspace.primaryRole).toBe("power");
    expect(withWorkspace.runtimeIdentity).toMatchObject({ sceneId: "scene-1" });
    expect(Object.isFrozen(withWorkspace.runtimeIdentity)).toBe(true);
    expect(withWorkspace.profile.instructions).toContain('work scene "写作场景"');
    expect(withWorkspace.profile.enabledTools).toContain("read");
    expect(withWorkspace.profile.enabledTools).toContain("admit_skill");
    expect(withoutWorkspace.workspace).toBeNull();
    expect(withoutWorkspace.profile.enabledTools).not.toContain("read");
    expect(withoutWorkspace.profile.enabledTools).not.toContain("admit_skill");
  });

  it("forms ephemeral and durable-job projections from the same exact tool facts", () => {
    const assembly = fixture();
    const ephemeral = assembly.ephemeral();
    const allJob = assembly.job({} as never);
    const restrictedJob = assembly.job({
      tools: ["read", "schedule", "mcp__alpha__tool"],
      model: "job-model",
    } as never);

    expect(ephemeral.extraTools.map((tool) => tool.name)).toEqual([
      "schedule",
      "task_list",
      "mcp__alpha__tool",
    ]);
    expect(ephemeral.executionMcpServers).toEqual(["alpha", "beta"]);
    expect(allJob.runtimeTools.extraTools.map((tool) => tool.name)).toEqual(
      ephemeral.extraTools.map((tool) => tool.name),
    );
    expect(restrictedJob.profile.enabledTools).toEqual(["read"]);
    expect(restrictedJob.runtimeTools.extraTools.map((tool) => tool.name)).toEqual([
      "schedule",
      "mcp__alpha__tool",
    ]);
    expect(restrictedJob.runtimeTools.executionMcpServers).toEqual(["alpha", "beta"]);
    expect(restrictedJob.modelOverride).toBe("job-model");
    expect(() => assembly.job({ tools: ["unknown-tool"] } as never)).toThrow(
      "Job requested unavailable tools: unknown-tool",
    );
  });

  it("derives capability catalog from the same projections and base assembler", () => {
    const catalog = fixture().capabilityCatalog();

    expect(Object.isFrozen(catalog)).toBe(true);
    expect(catalog.mcpServers).toEqual(["alpha", "beta"]);
    expect(catalog.tools).toEqual([...catalog.tools].sort());
    for (const name of [
      "read",
      "schedule",
      "task_list",
      "mcp__alpha__tool",
      "workmode_enter",
      "workmode_exit",
      "workscene_change_approve",
      "workscene_list",
      "workscene_rename_current",
      "workscene_set_workdir_current",
      "workscene_clear_workdir_current",
    ]) {
      expect(catalog.tools).toContain(name);
    }
  });
});

describe("Anchor conversation runtime routing", () => {
  it("routes main plus scene with supplied, absent and resolved workspace", async () => {
    const projections = fixture();
    const issued: unknown[] = [];
    const resolveWorkspaceRoot = vi.fn(async () => "/resolved");
    const prepareWorkspaceRoot = vi.fn(async () => {});
    const getScene = vi.fn(async () =>
      scene({ workspace: { deviceId: "device-1", bindingRef: "binding-1" } }),
    );
    const create = createWorksceneConversationRuntimeFactory({
      issue: async (projection) => {
        issued.push(projection);
        return { marker: "runtime" } as never;
      },
      projections,
      getScene,
      resolveWorkspaceRoot,
      prepareWorkspaceRoot,
    });

    await create("conversation-main", { workspaceRoot: "/main" });
    await create("ws:scene-1:provided", { workspaceRoot: "/provided" });
    getScene.mockResolvedValueOnce(scene({ id: "scene-2", name: "无目录" }));
    await create("ws:scene-2:no-workspace");
    getScene.mockResolvedValueOnce(
      scene({ workspace: { deviceId: "device-1", bindingRef: "binding-2" } }),
    );
    await create("ws:scene-1:resolved");

    expect(issued).toHaveLength(4);
    expect(issued[0]).toMatchObject({ workspace: "/main", primaryRole: "main" });
    expect(issued[1]).toMatchObject({ workspace: "/provided", primaryRole: "power" });
    expect(issued[2]).toMatchObject({ workspace: null, primaryRole: "power" });
    expect(issued[3]).toMatchObject({ workspace: "/resolved", primaryRole: "power" });
    expect(resolveWorkspaceRoot).toHaveBeenCalledTimes(1);
    expect(prepareWorkspaceRoot).toHaveBeenCalledWith("scene-1", "/resolved");
  });

  it("fails before publication when reread loses the scene workspace", async () => {
    const issue = vi.fn(async () => ({}) as never);
    const create = createWorksceneConversationRuntimeFactory({
      issue,
      projections: fixture(),
      getScene: async () =>
        scene({ workspace: { deviceId: "device-1", bindingRef: "binding-1" } }),
      resolveWorkspaceRoot: async () => null,
      prepareWorkspaceRoot: async () => {},
    });

    await expect(create("ws:scene-1:primary")).rejects.toThrow(
      '工作场景 "scene-1" 的工作区无法在当前 executor 解析',
    );
    expect(issue).not.toHaveBeenCalled();
  });

  it("fails before publication when the routed scene no longer exists", async () => {
    const issue = vi.fn(async () => ({}) as never);
    const create = createWorksceneConversationRuntimeFactory({
      issue,
      projections: fixture(),
      getScene: async () => null,
      resolveWorkspaceRoot: vi.fn(),
      prepareWorkspaceRoot: vi.fn(),
    });

    await expect(create("ws:scene-gone:primary")).rejects.toThrow(
      '工作场景 "scene-gone" 不存在,无法装配会话',
    );
    expect(issue).not.toHaveBeenCalled();
  });

  it("uses the first scene snapshot while the reread supplies only the resolved root", async () => {
    const projections = fixture();
    const issue = vi.fn(async () => ({}) as never);
    const create = createWorksceneConversationRuntimeFactory({
      issue,
      projections,
      getScene: async () =>
        scene({
          name: "首次名称",
          workspace: { deviceId: "device-1", bindingRef: "binding-old" },
        }),
      resolveWorkspaceRoot: async () => "/updated-binding-root",
      prepareWorkspaceRoot: async () => {},
    });

    await create("ws:scene-1:primary");

    const projection = issue.mock.calls[0]![0];
    expect(projection.workspace).toBe("/updated-binding-root");
    expect(projection.profile.instructions).toContain('work scene "首次名称"');
  });

  it("does not publish when product projection construction fails", async () => {
    const issue = vi.fn(async () => ({}) as never);
    const failure = new Error("projection failed");
    const projections = {
      main: vi.fn(() => {
        throw failure;
      }),
      scene: vi.fn(),
      ephemeral: vi.fn(),
      job: vi.fn(),
      capabilityCatalog: vi.fn(),
    } as never;
    const create = createWorksceneConversationRuntimeFactory({
      issue,
      projections,
      getScene: vi.fn(),
      resolveWorkspaceRoot: vi.fn(),
      prepareWorkspaceRoot: vi.fn(),
    });

    await expect(create("conversation-main")).rejects.toBe(failure);
    expect(issue).not.toHaveBeenCalled();
  });
});
