import { describe, it, expect } from "vitest";
import { createLoadSkillTool, createSaveSkillTool } from "../skill.js";
import type {
  SkillCatalogLoadApplication,
  SkillCatalogSaveApplication,
} from "@zhixing/core/skills/catalog";

const CTX = { workingDirectory: "." };

function loadApplicationWith(
  map: Record<string, { name: string; body: string }>,
): SkillCatalogLoadApplication {
  return {
    async load({ id }) {
      const result = map[id];
      if (!result) throw new Error(`技能 "${id}" 不存在`);
      return { id, name: result.name, body: result.body };
    },
  };
}

describe("load_skill 工具", () => {
  it("声明 app-state 边界、无 maxResultChars、不需确认", () => {
    const tool = createLoadSkillTool(loadApplicationWith({}));
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
      loadApplicationWith({ deploy: { name: "Deploy", body: "部署步骤正文" } }),
    );
    const r = await tool.call({ id: "deploy" }, CTX as never);
    expect(r.isError).toBe(false);
    expect(r.content).toContain("Deploy");
    expect(r.content).toContain("部署步骤正文");
  });

  it("不存在:isError + 错误信息", async () => {
    const tool = createLoadSkillTool(loadApplicationWith({}));
    const r = await tool.call({ id: "nope" }, CTX as never);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("nope");
  });

  it("空 id:isError、不调领域应用", async () => {
    let called = false;
    const application: SkillCatalogLoadApplication = {
      async load() {
        called = true;
        return { id: "", name: "", body: "" };
      },
    };
    const tool = createLoadSkillTool(application);
    const r = await tool.call({ id: "" }, CTX as never);
    expect(r.isError).toBe(true);
    expect(called).toBe(false);
  });
});

describe("save_skill 工具(Skill Catalog 应用端口的确认护栏包装)", () => {
  const okApplication: SkillCatalogSaveApplication = {
    async save(draft) {
      return {
        id: "deploy-flow",
        name: draft.name,
        outcome: "created",
        scrubbedCount: 0,
      };
    },
  };

  const INPUT = {
    name: "部署流程",
    description: "要部署生产时",
    body: "1. 构建",
  };

  it("成功暂存:content 含名称 / id / 提交后生效,不虚报已可唤起", async () => {
    const tool = createSaveSkillTool(okApplication, "main");
    const r = await tool.call(INPUT, CTX as never);
    expect(r.isError).toBe(false);
    expect(r.content).toContain("部署流程");
    expect(r.content).toContain("id: deploy-flow");
    expect(r.content).toContain("本轮成功完成后入库");
    expect(r.content).not.toContain("/deploy-flow");
    expect(r.content).toContain("新建");
    expect(r.content).not.toContain("密钥");
  });

  it("更新路径措辞 + 脱敏计数 > 0 时附诚实告知行", async () => {
    const application: SkillCatalogSaveApplication = {
      async save(draft) {
        return {
          id: "x",
          name: draft.name,
          outcome: "updated",
          scrubbedCount: 2,
        };
      },
    };
    const tool = createSaveSkillTool(application, "main");
    const r = await tool.call(INPUT, CTX as never);
    expect(r.content).toContain("更新");
    expect(r.content).toContain("2 处密钥");
  });

  it("mode 缺省取装配档(work 场景默认 work);显式 mode 优先", async () => {
    const seen: string[] = [];
    const application: SkillCatalogSaveApplication = {
      async save(draft) {
        seen.push(draft.mode);
        return { id: "x", name: draft.name, outcome: "created", scrubbedCount: 0 };
      },
    };
    const tool = createSaveSkillTool(application, "work");
    await tool.call(INPUT, CTX as never);
    await tool.call({ ...INPUT, mode: "main" }, CTX as never);
    expect(seen).toEqual(["work", "main"]);
  });

  it("缺任一必填字段:isError、不触发管线", async () => {
    let called = false;
    const application: SkillCatalogSaveApplication = {
      async save(draft) {
        called = true;
        return { id: "x", name: draft.name, outcome: "created", scrubbedCount: 0 };
      },
    };
    const tool = createSaveSkillTool(application, "main");
    const r = await tool.call({ name: "只有名字" }, CTX as never);
    expect(r.isError).toBe(true);
    expect(called).toBe(false);
  });

  it("管线抛错 → isError 透传消息,不抛出", async () => {
    const application: SkillCatalogSaveApplication = {
      async save() {
        throw new Error("磁盘满");
      },
    };
    const tool = createSaveSkillTool(application, "main");
    const r = await tool.call(INPUT, CTX as never);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("磁盘满");
  });

  it("系统护栏形态:无 boundaries 声明(走确认管线)、非只读、串行", () => {
    const tool = createSaveSkillTool(okApplication, "main");
    expect(tool.boundaries).toBeUndefined();
    expect(tool.isReadOnly).toBe(false);
    expect(tool.isParallelSafe).toBe(false);
  });
});
