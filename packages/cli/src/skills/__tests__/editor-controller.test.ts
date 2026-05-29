import { describe, it, expect } from "vitest";
import {
  SkillEditorController,
  type SkillEditorDeps,
} from "../editor-controller.js";
import type { SkillDraft } from "@zhixing/core";

const draftA: SkillDraft = {
  name: "部署服务",
  description: "部署到生产时用",
  body: "先 build 再推",
  mode: "main",
};

const mk = (over: Partial<SkillEditorDeps> = {}): SkillEditorController =>
  new SkillEditorController({
    edit: async () => draftA,
    save: async () => {},
    autoDraft: false,
    ...over,
  });

const sig = (): AbortSignal => new AbortController().signal;

describe("SkillEditorController — 起草 / 改写", () => {
  it("成功 → 换草稿、清错、回 editing", async () => {
    const c = mk({ edit: async () => draftA });
    await c.runEdit("记下部署做法", sig());
    expect(c.view().draft).toEqual(draftA);
    expect(c.view().phase).toBe("editing");
    expect(c.view().error).toBeNull();
  });

  it("失败 → 记错、留原草稿(无)、回 editing", async () => {
    const c = mk({
      edit: async () => {
        throw new Error("起草失败:模型未返回 JSON 草稿");
      },
    });
    await c.runEdit("x", sig());
    expect(c.view().draft).toBeNull();
    expect(c.view().error).toContain("起草失败");
    expect(c.view().phase).toBe("editing");
  });

  it("放弃等待(signal 已 abort)→ 结果丢弃、不污染草稿", async () => {
    let resolve!: (d: SkillDraft) => void;
    const c = mk({
      edit: () =>
        new Promise<SkillDraft>((r) => {
          resolve = r;
        }),
    });
    const ac = new AbortController();
    const p = c.runEdit("x", ac.signal);
    ac.abort();
    resolve(draftA);
    await p;
    expect(c.view().draft).toBeNull();
    expect(c.view().error).toBeNull();
  });
});

describe("SkillEditorController — 保存", () => {
  it("save 把当前草稿交给注入 writer", async () => {
    const saved: SkillDraft[] = [];
    const c = mk({ edit: async () => draftA, save: async (d) => void saved.push(d) });
    await c.runEdit("x", sig());
    await c.save();
    expect(saved).toEqual([draftA]);
  });
});

describe("SkillEditorController — 外部编辑两路衔接", () => {
  it("打开 → 进 external 暂停态", async () => {
    const c = mk({
      edit: async () => draftA,
      openExternal: async () => ({ file: "/tmp/SKILL.md", mtime: 100 }),
    });
    await c.runEdit("x", sig());
    await c.openExternalAndPause();
    expect(c.view().phase).toBe("external");
  });

  it("回屏:mtime 变了重读换草稿", async () => {
    const draftB: SkillDraft = { ...draftA, body: "外部改过的正文" };
    const c = mk({
      edit: async () => draftA,
      openExternal: async () => ({ file: "/tmp/SKILL.md", mtime: 100 }),
      rereadExternal: async () => ({ draft: draftB, mtime: 200 }),
    });
    await c.runEdit("x", sig());
    await c.openExternalAndPause();
    await c.resumeFromExternal();
    expect(c.view().draft).toEqual(draftB);
    expect(c.view().phase).toBe("editing");
  });

  it("回屏:未变(reread null)→ 保留原草稿", async () => {
    const c = mk({
      edit: async () => draftA,
      openExternal: async () => ({ file: "/tmp/SKILL.md", mtime: 100 }),
      rereadExternal: async () => null,
    });
    await c.runEdit("x", sig());
    await c.openExternalAndPause();
    await c.resumeFromExternal();
    expect(c.view().draft).toEqual(draftA);
    expect(c.view().phase).toBe("editing");
  });

  it("未注入 openExternal → canExternal=false、不进暂停态", async () => {
    const c = mk({ edit: async () => draftA });
    await c.runEdit("x", sig());
    expect(c.view().canExternal).toBe(false);
    await c.openExternalAndPause();
    expect(c.view().phase).toBe("editing");
  });
});

describe("SkillEditorController — 底部输入缓冲", () => {
  it("typeChar / backspace / takeInput", () => {
    const c = mk();
    c.typeChar("改");
    c.typeChar("简");
    c.typeChar("洁");
    expect(c.view().input).toBe("改简洁");
    c.backspace();
    expect(c.view().input).toBe("改简");
    expect(c.takeInput()).toBe("改简");
    expect(c.view().input).toBe("");
  });
});
