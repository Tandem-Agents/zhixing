import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WORKSCENE_MANAGEMENT_TOOLS,
  buildWorksceneChangeSummary,
  buildWorksceneToolConfirmationSummary,
  getEnabledWorksceneToolActions,
  getWorksceneToolBoundaries,
  getWorksceneToolPostTurnControlKind,
  getWorksceneToolsRequiringExplicitConfirmation,
  isWorksceneConfirmationDisplayTool,
  normalizeWorkdir,
  type WorksceneManagementToolName,
} from "../index.js";

describe("WORKSCENE_MANAGEMENT_TOOLS", () => {
  it("派生当前已实现的 change_approve action", () => {
    expect(getEnabledWorksceneToolActions("workscene_change_approve")).toEqual([
      "add",
      "remove",
      "rename",
      "set_workdir",
      "clear_workdir",
    ]);
  });

  it("边界与逐次拍板声明从同一张表派生", () => {
    expect(getWorksceneToolBoundaries("workmode_enter")).toEqual([
      { boundaryType: "agent-context", access: "switch", dynamic: false },
    ]);
    expect(getWorksceneToolBoundaries("workscene_set_workdir_current")).toEqual([
      { boundaryType: "agent-context", access: "switch", dynamic: false },
      { boundaryType: "filesystem", access: "write", dynamic: false },
    ]);
    expect(getWorksceneToolBoundaries("workscene_list")).toEqual([
      { boundaryType: "filesystem", access: "read", dynamic: false },
    ]);
    expect(getWorksceneToolsRequiringExplicitConfirmation().sort()).toEqual(
      [
        "workmode_enter",
        "workmode_exit",
        "workscene_change_approve",
        "workscene_clear_workdir_current",
        "workscene_rename_current",
        "workscene_set_workdir_current",
      ].sort(),
    );
    expect(getWorksceneToolsRequiringExplicitConfirmation()).not.toContain(
      "workscene_list",
    );
  });

  it("确认展示和 post-turn kind 由表声明", () => {
    expect(isWorksceneConfirmationDisplayTool("workscene_change_approve")).toBe(
      true,
    );
    expect(isWorksceneConfirmationDisplayTool("workscene_list")).toBe(false);
    expect(isWorksceneConfirmationDisplayTool("workmode_enter")).toBe(false);
    expect(getWorksceneToolPostTurnControlKind("workmode_enter")).toBe("enter");
    expect(getWorksceneToolPostTurnControlKind("workmode_exit")).toBe("exit");
    expect(getWorksceneToolPostTurnControlKind("workscene_set_workdir_current"))
      .toBe("set_workdir");
  });

  it("所有 workscene 确认展示工具都有显式摘要构造", () => {
    const longPath = path.join(path.sep, "tmp", "zhixing", "x".repeat(180));
    const sampleInputs: Partial<
      Record<WorksceneManagementToolName, Record<string, unknown>>
    > = {
      workscene_change_approve: {
        action: "set_workdir",
        sceneId: "scene-1",
        workdir: longPath,
      },
      workscene_rename_current: { name: "新名称" },
      workscene_set_workdir_current: { workdir: longPath },
      workscene_clear_workdir_current: {},
    };
    const displayContext = {
      workscene: { sceneId: "scene-current", sceneName: "当前场景" },
    };

    for (const [toolName, spec] of Object.entries(
      WORKSCENE_MANAGEMENT_TOOLS,
    )) {
      if (spec.confirmationDisplay !== "workscene") continue;
      const name = toolName as WorksceneManagementToolName;
      const input = sampleInputs[name] ?? {};
      const summary = buildWorksceneToolConfirmationSummary(name, input, {
        displayContext,
      });

      expect(summary).toContain("动作：");
      expect(summary).not.toBe(`${name} ${JSON.stringify(input)}`);
      expect(summary).not.toMatch(/^\w+ \{/);
    }
  });
});

describe("buildWorksceneChangeSummary", () => {
  it("规范化名称和工作目录,完整路径不截断", () => {
    const longPath = path.join(path.sep, "tmp", "zhixing", "x".repeat(180));
    const normalized = normalizeWorkdir(longPath);
    const summary = buildWorksceneChangeSummary({
      action: "add",
      name: "  写作场景  ",
      workdir: longPath,
    });

    expect(summary).toContain("动作：创建工作场景");
    expect(summary).toContain("新场景：写作场景");
    expect(summary).toContain(`工作目录：${normalized}`);
    expect(summary).not.toContain("…");
  });

  it("主模式已有场景动作展示稳定 sceneId,不信任 sceneName", () => {
    const summary = buildWorksceneChangeSummary({
      action: "rename",
      sceneId: "scene-alpha",
      name: " 新名称 ",
    });

    expect(summary).toContain("目标场景：scene-alpha");
    expect(summary).toContain("新名称：新名称");
  });

  it("当前场景动作展示闭包上下文中的 sceneName 与 sceneId", () => {
    const summary = buildWorksceneToolConfirmationSummary(
      "workscene_rename_current",
      { name: "新场景名" },
      {
        displayContext: {
          workscene: { sceneId: "scene-1", sceneName: "旧场景名" },
        },
      },
    );

    expect(summary).toContain("当前场景：旧场景名 (scene-1)");
    expect(summary).toContain("新名称：新场景名");
  });

  it("可携带存在性提示,但默认管线摘要不包含提示", () => {
    const change = {
      action: "set_workdir",
      sceneId: "scene-1",
      workdir: path.join(path.sep, "tmp", "missing"),
    };

    expect(buildWorksceneChangeSummary(change)).not.toContain("提示：");
    expect(
      buildWorksceneChangeSummary(change, {
        workdirNotice: "下次进入将自动创建",
      }),
    ).toContain("提示：下次进入将自动创建");
  });
});
