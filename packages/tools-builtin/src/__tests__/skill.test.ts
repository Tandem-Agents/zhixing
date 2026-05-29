import { describe, it, expect } from "vitest";
import { createLoadSkillTool } from "../skill.js";
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
