import { describe, it, expect } from "vitest";
import { userMessage } from "@zhixing/core";
import type { SkillDraft } from "@zhixing/core";
import {
  buildSkillContext,
  draftToExternalFile,
  externalFileToDraft,
} from "../authoring-command.js";

describe("buildSkillContext", () => {
  it("把消息转成 who: text 行", () => {
    const ctx = buildSkillContext([
      userMessage("我要记录部署做法"),
      userMessage("先 build 再推镜像"),
    ]);
    expect(ctx).toContain("用户: 我要记录部署做法");
    expect(ctx).toContain("用户: 先 build 再推镜像");
  });

  it("只取最近 limit 条", () => {
    const many = Array.from({ length: 30 }, (_, i) => userMessage(`m${i}`));
    const ctx = buildSkillContext(many, 5);
    expect(ctx.split("\n")).toHaveLength(5);
    expect(ctx).toContain("m29");
    expect(ctx).not.toContain("m24");
  });

  it("空文本消息被跳过", () => {
    const ctx = buildSkillContext([userMessage("hi"), userMessage("   ")]);
    expect(ctx).toBe("用户: hi");
  });
});

describe("外部编辑文件 round-trip", () => {
  const draft: SkillDraft = {
    name: "部署服务",
    description: "部署到生产、需回滚时用",
    body: "先 build\n再推镜像",
    mode: "work",
  };
  const base: SkillDraft = {
    name: "旧名",
    description: "旧描述",
    body: "旧正文",
    mode: "main",
  };

  it("草稿 → 文件 → 草稿:字段(含 mode)保留", () => {
    const back = externalFileToDraft(draftToExternalFile(draft), base);
    expect(back.name).toBe("部署服务");
    expect(back.description).toBe("部署到生产、需回滚时用");
    expect(back.mode).toBe("work");
    expect(back.body).toContain("先 build");
    expect(back.body).toContain("再推镜像");
  });

  it("文件缺 mode → 回落到 base.mode", () => {
    const noMode = `---\nname: 部署服务\ndescription: d\n---\n正文`;
    expect(externalFileToDraft(noMode, base).mode).toBe("main");
  });

  it("文件 name 空 → 回落到 base.name", () => {
    const noName = `---\nname: ""\ndescription: d\n---\n正文`;
    expect(externalFileToDraft(noName, base).name).toBe("旧名");
  });

  it("文件非法 mode → 回落到 base.mode", () => {
    const badMode = `---\nname: n\ndescription: d\nmode: bogus\n---\n正文`;
    expect(externalFileToDraft(badMode, base).mode).toBe("main");
  });
});
