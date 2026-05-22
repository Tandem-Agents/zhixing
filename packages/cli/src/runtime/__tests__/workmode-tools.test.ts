/**
 * workmode 工具回归 —— 脱离 RuntimeSession，用 mock IWorkModeController 验证：
 *   - enter/exit 只 emit 意图、不执行切换
 *   - enter 对不存在场景 isError 且不 emit
 *   - change_approve 派发到 registry 各 CRUD
 *   - 权限/只读标志符合 by-construction 约束
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore, getWorkSceneMemoryDir } from "@zhixing/core";
import { createTempDir } from "@zhixing/test-utils";
import type { IWorkModeController } from "../work-mode-controller.js";
import {
  createWorkmodeEnterTool,
  createWorkmodeExitTool,
  createWorksceneChangeApproveTool,
  createWorksceneMemoryQueryTool,
} from "../workmode-tools.js";

function makeController(
  overrides: Partial<IWorkModeController["registry"]> = {},
  controllerOverrides: Partial<IWorkModeController> = {},
): IWorkModeController & { emitted: unknown[] } {
  const emitted: unknown[] = [];
  return {
    emitted,
    emitModeSwitch: (intent) => {
      emitted.push(intent);
    },
    // 带 guard 的删除入口 —— RuntimeSession 实现内含 active 守卫;
    // 这里默认放一个无 guard 的 mock,需要测 guard 行为的 case 用
    // controllerOverrides 注入抛错版本。
    removeWorkScene: vi.fn().mockResolvedValue(undefined),
    registry: {
      get: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      add: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn(),
      touch: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    },
    ...controllerOverrides,
  } as unknown as IWorkModeController & { emitted: unknown[] };
}

const CTX = {} as never;

describe("workmode_enter", () => {
  it("场景存在 → emit enter 意图、不执行切换", async () => {
    const c = makeController({
      get: vi
        .fn()
        .mockResolvedValue({ id: "s1", name: "场景一", createdAt: "", lastActiveAt: "" }),
    });
    const tool = createWorkmodeEnterTool(c);
    expect(tool.needsPermission).toBe(true);
    // boundaries 是真正驱动 confirm 的字段(needsPermission 当前在运行时无消费):
    // 声明 agent-context.switch 让 OperationClassifier 升级到 external → confirm。
    expect(tool.boundaries).toEqual([
      { boundaryType: "agent-context", access: "switch", dynamic: false },
    ]);
    const r = await tool.call({ sceneId: "s1" }, CTX);
    expect(r.isError).toBeFalsy();
    expect(c.emitted).toEqual([{ kind: "enter", sceneId: "s1" }]);
  });

  it("场景不存在 → isError 且不 emit", async () => {
    const c = makeController(); // get → null
    const tool = createWorkmodeEnterTool(c);
    const r = await tool.call({ sceneId: "nope" }, CTX);
    expect(r.isError).toBe(true);
    expect(c.emitted).toEqual([]);
  });
});

describe("workmode_exit", () => {
  it("声明 agent-context.switch → confirm；emit exit 意图", async () => {
    const c = makeController();
    const tool = createWorkmodeExitTool(c);
    // 退出和进入对称都要拍板:声明 agent-context.switch(external → confirm)。
    // 用户主动 /exit cli 命令不经此工具,天然无需确认。
    expect(tool.needsPermission).toBe(true);
    expect(tool.boundaries).toEqual([
      { boundaryType: "agent-context", access: "switch", dynamic: false },
    ]);
    const r = await tool.call({}, CTX);
    expect(r.isError).toBeFalsy();
    expect(c.emitted).toEqual([{ kind: "exit" }]);
  });
});

describe("workscene_change_approve", () => {
  it("needsPermission + filesystem.write → confirm; 按 action 派发 registry", async () => {
    const add = vi
      .fn()
      .mockResolvedValue({ id: "x", name: "新场景", createdAt: "", lastActiveAt: "" });
    const c = makeController({ add });
    const tool = createWorksceneChangeApproveTool(c);
    expect(tool.needsPermission).toBe(true);
    // 写场景注册表 → filesystem.write → external → confirm。
    expect(tool.boundaries).toEqual([
      { boundaryType: "filesystem", access: "write", dynamic: false },
    ]);

    await tool.call({ action: "add", name: "新场景" }, CTX);
    expect(add).toHaveBeenCalledWith({ name: "新场景", workdir: undefined });

    // remove 走 controller.removeWorkScene(带 active guard),不直接调 registry.remove。
    // 单参彻底删除;purgeData / 软删除语义已废除。
    await tool.call({ action: "remove", sceneId: "x" }, CTX);
    expect(c.removeWorkScene).toHaveBeenCalledWith("x");
    expect(c.registry.remove).not.toHaveBeenCalled();
  });

  it("remove 触发 active guard → 工具返回 isError、不抛", async () => {
    // 模拟 RuntimeSession.removeWorkScene 抛 active-scene guard 错误
    const c = makeController(
      {},
      {
        removeWorkScene: vi
          .fn()
          .mockRejectedValue(
            new Error('无法删除当前活跃的工作场景 "x" —— 请先 /exit'),
          ),
      },
    );
    const tool = createWorksceneChangeApproveTool(c);
    const r = await tool.call({ action: "remove", sceneId: "x" }, CTX);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("无法删除当前活跃的工作场景");
  });

  it("缺必填参数 → isError，不调 registry", async () => {
    const c = makeController();
    const tool = createWorksceneChangeApproveTool(c);
    const r = await tool.call({ action: "add" }, CTX);
    expect(r.isError).toBe(true);
    expect(c.registry.add).not.toHaveBeenCalled();
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

  function controllerWith(
    scenes: typeof SCENE[],
  ): IWorkModeController {
    return {
      emitModeSwitch: vi.fn(),
      registry: {
        list: vi.fn().mockResolvedValue(scenes),
        get: vi
          .fn()
          .mockImplementation(async (id: string) =>
            scenes.find((s) => s.id === id) ?? null,
          ),
        add: vi.fn(),
        remove: vi.fn(),
        rename: vi.fn(),
        touch: vi.fn(),
      },
    } as unknown as IWorkModeController;
  }

  it("query 模式：命中场景记忆，返回 id+片段", async () => {
    await new MemoryStore(getWorkSceneMemoryDir("scene-a")).save({
      category: "skill",
      id: "slug1",
      meta: { title: "标题1" },
      content: "这里包含关键词 alpha 的技能正文",
    });
    const c = controllerWith([SCENE]);
    const tool = createWorksceneMemoryQueryTool(c);
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
    expect(c.registry.list).toHaveBeenCalledWith();
  });

  it("无 query：返回各类别 id 索引", async () => {
    await new MemoryStore(getWorkSceneMemoryDir("scene-a")).save({
      category: "skill",
      id: "skillX",
      meta: {},
      content: "正文",
    });
    const tool = createWorksceneMemoryQueryTool(controllerWith([SCENE]));
    const r = await tool.call({}, CTX);
    expect(r.content).toContain("skill: skillX");
  });

  it("片段按上限截断（不 raw dump 整条）", async () => {
    const long = "x".repeat(2000);
    await new MemoryStore(getWorkSceneMemoryDir("scene-a")).save({
      category: "skill",
      id: "big",
      meta: { title: "大" },
      content: `命中词 beta ${long}`,
    });
    const tool = createWorksceneMemoryQueryTool(controllerWith([SCENE]));
    const r = await tool.call({ query: "beta" }, CTX);
    // 截断后不应包含完整 2000 x 尾部
    expect(r.content).not.toContain(long);
  });

  it("指定不存在的 sceneId → 友好提示，不抛", async () => {
    const tool = createWorksceneMemoryQueryTool(controllerWith([SCENE]));
    const r = await tool.call({ sceneId: "nope" }, CTX);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("不存在");
  });
});
