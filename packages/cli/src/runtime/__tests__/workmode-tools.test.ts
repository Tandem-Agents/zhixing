/**
 * workmode 工具回归 —— 脱离核心宿主,用 mock 工作场景领域服务验证:
 *   - enter/exit 只 emit 意图(经 ALS 发当前 run 的 bus),不执行切换
 *   - enter 对不存在场景 isError 且不 emit
 *   - change_approve 派发到领域服务各管理动作
 *   - list / memory_query 都是只读观察工具
 *   - 权限/只读标志符合 by-construction 约束
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryStore,
  createEventBus,
  getEnabledWorksceneToolActions,
  getWorkSceneMemoryDir,
  getWorksceneToolBoundaries,
  type AgentEventMap,
  type WorkScene,
} from "@zhixing/core";
import { runContextStorage } from "@zhixing/orchestrator/runtime";
import { createTempDir } from "@zhixing/test-utils";
import {
  createWorkmodeEnterTool,
  createWorkmodeExitTool,
  createWorksceneChangeApproveTool,
  createWorksceneListTool,
  createWorksceneMemoryQueryTool,
  type WorksceneToolDirectory,
} from "../workmode-tools.js";

function makeDirectory(
  overrides: Partial<WorksceneToolDirectory> = {},
): WorksceneToolDirectory {
  return {
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    remove: vi.fn().mockResolvedValue(true),
    rename: vi.fn(),
    setWorkdir: vi.fn(),
    ...overrides,
  } as unknown as WorksceneToolDirectory;
}

const CTX = {} as never;

/**
 * 在带捕获 bus 的 RunContext 内执行——意图经 emitWorkModeSwitchIntent 发
 * 当前 run 的 bus(与真实 run 同机制),返回捕获到的意图序列。
 */
async function callInRun<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; emitted: unknown[] }> {
  const bus = createEventBus<AgentEventMap>({ lineage: "main" });
  const emitted: unknown[] = [];
  bus.on("workmode:switch_requested", (intent) => {
    emitted.push(intent);
  });
  const result = await runContextStorage.run({ bus, lineage: "main" }, fn);
  return { result, emitted };
}

describe("workmode_enter", () => {
  it("场景存在 → emit enter 意图、不执行切换", async () => {
    const directory = makeDirectory({
      get: vi.fn().mockResolvedValue({
        id: "s1",
        name: "场景一",
        createdAt: "",
        lastActiveAt: "",
      }),
    });
    const tool = createWorkmodeEnterTool(directory);
    expect(tool.needsPermission).toBe(true);
    expect(tool.requiresExplicitConfirmation).toBe(true);
    expect(tool.boundaries).toEqual(getWorksceneToolBoundaries("workmode_enter"));
    const { result, emitted } = await callInRun(() =>
      tool.call({ sceneId: "s1" }, CTX),
    );
    expect(result.isError).toBeFalsy();
    expect(emitted).toEqual([{ kind: "enter", sceneId: "s1" }]);
  });

  it("场景不存在 → isError 且不 emit", async () => {
    const directory = makeDirectory(); // get → null
    const tool = createWorkmodeEnterTool(directory);
    const { result, emitted } = await callInRun(() =>
      tool.call({ sceneId: "nope" }, CTX),
    );
    expect(result.isError).toBe(true);
    expect(emitted).toEqual([]);
  });
});

describe("workmode_exit", () => {
  it("声明 agent-context.switch → confirm；emit exit 意图", async () => {
    const tool = createWorkmodeExitTool();
    // 退出和进入对称都要拍板:声明 agent-context.switch(external → confirm)。
    // 用户主动 /exit cli 命令不经此工具,天然无需确认。
    expect(tool.needsPermission).toBe(true);
    expect(tool.requiresExplicitConfirmation).toBe(true);
    expect(tool.boundaries).toEqual(getWorksceneToolBoundaries("workmode_exit"));
    const { result, emitted } = await callInRun(() => tool.call({}, CTX));
    expect(result.isError).toBeFalsy();
    expect(emitted).toEqual([{ kind: "exit" }]);
  });
});

describe("workscene_change_approve", () => {
  it("needsPermission + filesystem.write → confirm; 按 action 派发领域服务", async () => {
    const create = vi.fn().mockResolvedValue({
      scene: { id: "x", name: "新场景", createdAt: "", lastActiveAt: "" },
    });
    const remove = vi.fn().mockResolvedValue(true);
    const rename = vi.fn().mockResolvedValue({
      id: "x",
      name: "新名称",
      createdAt: "",
      lastActiveAt: "",
    });
    const setWorkdir = vi.fn().mockResolvedValue({
      scene: {
        id: "x",
        name: "新名称",
        workdir: "/tmp/project",
        createdAt: "",
        lastActiveAt: "",
      },
    });
    const directory = makeDirectory({ create, remove, rename, setWorkdir });
    const tool = createWorksceneChangeApproveTool(directory);
    expect(tool.needsPermission).toBe(true);
    expect(tool.requiresExplicitConfirmation).toBe(true);
    expect(tool.boundaries).toEqual(
      getWorksceneToolBoundaries("workscene_change_approve"),
    );
    expect(tool.inputSchema.properties?.action?.enum).toEqual(
      getEnabledWorksceneToolActions("workscene_change_approve"),
    );

    await tool.call({ action: "add", name: "新场景" }, CTX);
    expect(create).toHaveBeenCalledWith({ name: "新场景", workdir: undefined });

    await tool.call({ action: "remove", sceneId: "x" }, CTX);
    expect(remove).toHaveBeenCalledWith("x");

    await tool.call({ action: "rename", sceneId: "x", name: "新名称" }, CTX);
    expect(rename).toHaveBeenCalledWith("x", "新名称");

    await tool.call({
      action: "set_workdir",
      sceneId: "x",
      workdir: "/tmp/project",
    }, CTX);
    expect(setWorkdir).toHaveBeenCalledWith("x", "/tmp/project");

    await tool.call({ action: "clear_workdir", sceneId: "x" }, CTX);
    expect(setWorkdir).toHaveBeenCalledWith("x", null);
  });

  it("领域服务守卫失败 → 工具返回 isError、不抛", async () => {
    const directory = makeDirectory({
      remove: vi
        .fn()
        .mockRejectedValue(
          new Error('无法删除当前活跃的工作场景 "x" —— 请先 /exit'),
        ),
    });
    const tool = createWorksceneChangeApproveTool(directory);
    const r = await tool.call({ action: "remove", sceneId: "x" }, CTX);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("无法删除当前活跃的工作场景");
  });

  it("缺必填参数 → isError,不调领域服务;set_workdir 缺 workdir 不解绑", async () => {
    const directory = makeDirectory();
    const tool = createWorksceneChangeApproveTool(directory);
    const r = await tool.call({ action: "add" }, CTX);
    expect(r.isError).toBe(true);
    expect(directory.create).not.toHaveBeenCalled();

    const setMissing = await tool.call({ action: "set_workdir", sceneId: "x" }, CTX);
    expect(setMissing.isError).toBe(true);
    expect(directory.setWorkdir).not.toHaveBeenCalled();
  });
});

describe("workscene_list", () => {
  it("只读返回 workdir 管理元数据", async () => {
    const directory = makeDirectory({
      list: vi.fn().mockResolvedValue([
        {
          id: "scene-a",
          name: "场景A",
          workdir: "/tmp/project",
          createdAt: "",
          lastActiveAt: "2026-07-07T00:00:00.000Z",
        },
        { id: "scene-b", name: "场景B", createdAt: "", lastActiveAt: "" },
      ] satisfies WorkScene[]),
    });
    const tool = createWorksceneListTool(directory);
    expect(tool.isReadOnly).toBe(true);
    expect(tool.needsPermission).toBe(false);
    expect(tool.boundaries).toEqual(getWorksceneToolBoundaries("workscene_list"));

    const r = await tool.call({}, CTX);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("场景A (id: scene-a)");
    expect(r.content).toContain("工作目录：/tmp/project");
    expect(r.content).toContain("场景B (id: scene-b)");
    expect(r.content).toContain("工作目录：未绑定");
  });
});

describe("workscene_memory_query", () => {
  let originalHome: string | undefined;

  beforeEach(async () => {
    const tmpDir = await createTempDir("workscene-mem-query");
    originalHome = process.env.ZHIXING_HOME;
    process.env.ZHIXING_HOME = tmpDir;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ZHIXING_HOME;
    else process.env.ZHIXING_HOME = originalHome;
  });

  const SCENE = {
    id: "scene-a",
    name: "场景A",
    createdAt: "",
    lastActiveAt: "",
  };

  function directoryWith(scenes: typeof SCENE[]): WorksceneToolDirectory {
    return makeDirectory({
      list: vi.fn().mockResolvedValue(scenes),
      get: vi
        .fn()
        .mockImplementation(async (id: string) =>
          scenes.find((s) => s.id === id) ?? null,
        ),
    });
  }

  it("query 模式：命中场景记忆，返回 id+片段", async () => {
    await new MemoryStore(getWorkSceneMemoryDir("scene-a")).save({
      category: "person",
      id: "slug1",
      meta: { name: "标题1" },
      content: "这里包含关键词 alpha 的人物正文",
    });
    const directory = directoryWith([SCENE]);
    const tool = createWorksceneMemoryQueryTool(directory);
    expect(tool.isReadOnly).toBe(true);
    expect(tool.needsPermission).toBe(false);
    // 只读检索场景记忆域 → filesystem.read → observe → 自动放行(不弹窗)。
    expect(tool.boundaries).toEqual([
      { boundaryType: "filesystem", access: "read", dynamic: false },
    ]);

    const r = await tool.call({ query: "alpha" }, CTX);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("场景A");
    expect(r.content).toContain("slug1");
    expect(r.content).toContain("关键词 alpha");
    expect(directory.list).toHaveBeenCalledWith();
  });

  it("无 query：返回各类别 id 索引", async () => {
    await new MemoryStore(getWorkSceneMemoryDir("scene-a")).save({
      category: "person",
      id: "personX",
      meta: {},
      content: "正文",
    });
    const tool = createWorksceneMemoryQueryTool(directoryWith([SCENE]));
    const r = await tool.call({}, CTX);
    expect(r.content).toContain("person: personX");
  });

  it("片段按上限截断（不 raw dump 整条）", async () => {
    const long = "x".repeat(2000);
    await new MemoryStore(getWorkSceneMemoryDir("scene-a")).save({
      category: "person",
      id: "big",
      meta: { name: "大" },
      content: `命中词 beta ${long}`,
    });
    const tool = createWorksceneMemoryQueryTool(directoryWith([SCENE]));
    const r = await tool.call({ query: "beta" }, CTX);
    // 截断后不应包含完整 2000 x 尾部
    expect(r.content).not.toContain(long);
  });

  it("指定不存在的 sceneId → 友好提示，不抛", async () => {
    const tool = createWorksceneMemoryQueryTool(directoryWith([SCENE]));
    const r = await tool.call({ sceneId: "nope" }, CTX);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("不存在");
  });
});
