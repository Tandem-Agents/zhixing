import { describe, it, expect } from "vitest";
import { createLoadSkillTool, createSaveSkillTool } from "../skill.js";
import type { SkillTextLoader } from "@zhixing/core";

const CTX = { workingDirectory: "." };

function loaderWith(
  map: Record<string, { name: string; body: string }>,
): SkillTextLoader {
  return {
    async loadText(id) {
      const r = map[id];
      if (!r) throw new Error(`技能 "${id}" 不存在`);
      return { id, name: r.name, body: r.body };
    },
  };
}

describe("load_skill 工具", () => {
  it("声明 app-state 边界、无 maxResultChars、不需确认", () => {
    const tool = createLoadSkillTool(loaderWith({}));
    expect(tool.name).toBe("load_skill");
    expect(tool.boundaries).toEqual([
      { boundaryType: "app-state", access: "write", dynamic: false },
    ]);
    expect(tool.maxResultChars).toBeUndefined();
    expect(tool.needsPermission).toBe(false);
    expect(tool.isParallelSafe).toBe(true);
  });

  it("命中:返回全文(含技能名)", async () => {
    const tool = createLoadSkillTool(
      loaderWith({ deploy: { name: "Deploy", body: "部署步骤正文" } }),
    );
    const r = await tool.call({ id: "deploy" }, CTX as never);
    expect(r.isError).toBe(false);
    expect(r.content).toContain("Deploy");
    expect(r.content).toContain("部署步骤正文");
  });

  it("不存在:isError + 错误信息", async () => {
    const tool = createLoadSkillTool(loaderWith({}));
    const r = await tool.call({ id: "nope" }, CTX as never);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("nope");
  });

  it("空 id:isError、不调底层 loader", async () => {
    let called = false;
    const loader: SkillTextLoader = {
      async loadText() {
        called = true;
        return { id: "", name: "", body: "" };
      },
    };
    const tool = createLoadSkillTool(loader);
    const r = await tool.call({ id: "" }, CTX as never);
    expect(r.isError).toBe(true);
    expect(called).toBe(false);
  });
});

describe("save_skill 工具(SkillSavePipeline 的确认护栏包装)", () => {
  const okSaver: import("../skill.js").SkillSaver = async (draft) => ({
    id: "deploy-flow",
    name: draft.name,
    outcome: "created",
    scrubbedCount: 0,
  });

  const INPUT = {
    name: "部署流程",
    description: "要部署生产时",
    body: "1. 构建",
  };

  it("成功保存:content 含名称 / id / 唤起提示,新建措辞", async () => {
    const tool = createSaveSkillTool(okSaver, "main");
    const r = await tool.call(INPUT, CTX as never);
    expect(r.isError).toBe(false);
    expect(r.content).toContain("部署流程");
    expect(r.content).toContain("/deploy-flow");
    expect(r.content).toContain("新建");
    expect(r.content).not.toContain("密钥");
  });

  it("更新路径措辞 + 脱敏计数 > 0 时附诚实告知行", async () => {
    const saver: import("../skill.js").SkillSaver = async (draft) => ({
      id: "x",
      name: draft.name,
      outcome: "updated",
      scrubbedCount: 2,
    });
    const tool = createSaveSkillTool(saver, "main");
    const r = await tool.call(INPUT, CTX as never);
    expect(r.content).toContain("更新");
    expect(r.content).toContain("2 处密钥");
  });

  it("mode 缺省取装配档(work 场景默认 work);显式 mode 优先", async () => {
    const seen: string[] = [];
    const saver: import("../skill.js").SkillSaver = async (draft) => {
      seen.push(draft.mode);
      return { id: "x", name: draft.name, outcome: "created", scrubbedCount: 0 };
    };
    const tool = createSaveSkillTool(saver, "work");
    await tool.call(INPUT, CTX as never);
    await tool.call({ ...INPUT, mode: "main" }, CTX as never);
    expect(seen).toEqual(["work", "main"]);
  });

  it("缺任一必填字段:isError、不触发管线", async () => {
    let called = false;
    const saver: import("../skill.js").SkillSaver = async (draft) => {
      called = true;
      return { id: "x", name: draft.name, outcome: "created", scrubbedCount: 0 };
    };
    const tool = createSaveSkillTool(saver, "main");
    const r = await tool.call({ name: "只有名字" }, CTX as never);
    expect(r.isError).toBe(true);
    expect(called).toBe(false);
  });

  it("管线抛错 → isError 透传消息,不抛出", async () => {
    const saver: import("../skill.js").SkillSaver = async () => {
      throw new Error("磁盘满");
    };
    const tool = createSaveSkillTool(saver, "main");
    const r = await tool.call(INPUT, CTX as never);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("磁盘满");
  });

  it("系统护栏形态:无 boundaries 声明(走确认管线)、非只读、串行", () => {
    const tool = createSaveSkillTool(okSaver, "main");
    expect(tool.boundaries).toBeUndefined();
    expect(tool.isReadOnly).toBe(false);
    expect(tool.isParallelSafe).toBe(false);
  });
});
