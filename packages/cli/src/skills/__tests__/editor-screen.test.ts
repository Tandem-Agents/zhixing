import { describe, it, expect } from "vitest";
import { stripAnsi, type KeyEvent, type KeyEventStream } from "../../tui/index.js";
import {
  renderSkillEditor,
  handleEditorKey,
  runDraftWithCancel,
} from "../editor-screen.js";
import {
  SkillEditorController,
  type SkillEditorDeps,
  type SkillEditorView,
} from "../editor-controller.js";
import type { SkillDraft } from "@zhixing/core";

const draftA: SkillDraft = {
  name: "部署服务",
  description: "部署到生产时用",
  body: "先 build 再推镜像",
  mode: "work",
};

const plain = (view: SkillEditorView): string =>
  stripAnsi(renderSkillEditor(view, 80, "新建技能").join("\n"));

const view = (over: Partial<SkillEditorView>): SkillEditorView => ({
  draft: null,
  input: "",
  inputCursor: 0,
  phase: "editing",
  error: null,
  canExternal: false,
  ...over,
});

describe("renderSkillEditor", () => {
  it("无草稿 → 引导文案 + 输入区", () => {
    const out = plain(view({}));
    expect(out).toContain("还没有草稿");
    expect(out).toContain("Enter 提交");
  });

  it("有草稿 → 字段 + 正文 + 落点路径 + 正文分隔线", () => {
    const out = plain(view({ draft: draftA }));
    expect(out).toContain("部署服务");
    expect(out).toContain("部署到生产时用");
    expect(out).toContain("work"); // 模式行(无方括号)
    expect(out).toContain("先 build 再推镜像");
    expect(out).toContain("own/"); // 落点 id 预览
    expect(out).toContain("── 正文 ─"); // 全宽小节分隔线
  });

  it("canExternal → 输入框 hint 出现 Ctrl+E", () => {
    expect(plain(view({ draft: draftA, canExternal: true }))).toContain(
      "Ctrl+E 外部编辑器",
    );
    expect(plain(view({ draft: draftA, canExternal: false }))).not.toContain(
      "Ctrl+E",
    );
  });

  it("editing 态 → 带框输入区(标题随草稿态变 + hint)", () => {
    const withDraft = plain(view({ draft: draftA }));
    expect(withDraft).toContain("想怎么改？"); // 有草稿:问怎么改
    expect(withDraft).toContain("回车 提交"); // 输入框 hint
    const noDraft = plain(view({}));
    expect(noDraft).toContain("想要个什么技能？"); // 无草稿:问意图
  });

  it("drafting 态 → 保留内容、底部显示起草中(非 spinner 全屏)", () => {
    const out = plain(view({ draft: draftA, phase: "drafting" }));
    expect(out).toContain("起草中");
    expect(out).toContain("部署服务"); // 内容区仍在
    expect(out).toContain("Ctrl+C 取消");
  });

  it("external 态 → 提示读回", () => {
    const out = plain(view({ draft: draftA, phase: "external" }));
    expect(out).toContain("外部编辑器已打开");
    expect(out).toContain("按任意键读回");
  });

  it("error → 红色警示行", () => {
    expect(plain(view({ error: "起草失败:模型未返回 JSON 草稿" }))).toContain(
      "起草失败",
    );
  });
});

const draftA2: SkillDraft = draftA;
const mk = (over: Partial<SkillEditorDeps> = {}): SkillEditorController =>
  new SkillEditorController({
    edit: async () => draftA2,
    save: async () => {},
    autoDraft: false,
    ...over,
  });
const seeded = async (
  over: Partial<SkillEditorDeps> = {},
): Promise<SkillEditorController> => {
  const c = mk(over);
  await c.runEdit("seed", new AbortController().signal);
  return c;
};
const char = (ch: string): KeyEvent => ({ type: "char", ch });

describe("handleEditorKey", () => {
  it("char / backspace 改输入缓冲", () => {
    const c = mk();
    expect(handleEditorKey(c, char("改"))).toEqual({ kind: "continue" });
    handleEditorKey(c, char("简"));
    expect(c.view().input).toBe("改简");
    handleEditorKey(c, { type: "backspace" });
    expect(c.view().input).toBe("改");
  });

  it("← → 移动光标(中间插入)", () => {
    const c = mk();
    handleEditorKey(c, char("a"));
    handleEditorKey(c, char("c"));
    expect(handleEditorKey(c, { type: "arrow-left" })).toEqual({ kind: "continue" });
    expect(c.view().inputCursor).toBe(1);
    handleEditorKey(c, char("b"));
    expect(c.view().input).toBe("abc");
    handleEditorKey(c, { type: "arrow-right" });
    expect(c.view().inputCursor).toBe(3);
  });

  it("回车 + 非空输入 → submit 并清空", () => {
    const c = mk();
    handleEditorKey(c, char("改"));
    handleEditorKey(c, char("尖"));
    expect(handleEditorKey(c, { type: "enter" })).toEqual({
      kind: "submit",
      instruction: "改尖",
    });
    expect(c.view().input).toBe("");
  });

  it("回车 + 空输入 → continue", () => {
    expect(handleEditorKey(mk(), { type: "enter" })).toEqual({ kind: "continue" });
  });

  it("Ctrl+S:有草稿 → save;无草稿 → continue", async () => {
    expect(handleEditorKey(mk(), { type: "ctrl-s" })).toEqual({ kind: "continue" });
    expect(handleEditorKey(await seeded(), { type: "ctrl-s" })).toEqual({
      kind: "save",
    });
  });

  it("Ctrl+E:有草稿且可外部编辑 → external;否则 continue", async () => {
    const withExt = await seeded({
      openExternal: async () => ({ file: "/tmp/x", mtime: 1 }),
    });
    expect(handleEditorKey(withExt, { type: "ctrl-e" })).toEqual({
      kind: "external",
    });
    expect(handleEditorKey(await seeded(), { type: "ctrl-e" })).toEqual({
      kind: "continue",
    });
  });

  it("Ctrl+C / Esc → cancel", () => {
    expect(handleEditorKey(mk(), { type: "ctrl-c" })).toEqual({ kind: "cancel" });
    expect(handleEditorKey(mk(), { type: "escape" })).toEqual({ kind: "cancel" });
  });

  it("external 暂停态:任意键 → resume", async () => {
    const c = await seeded({
      openExternal: async () => ({ file: "/tmp/x", mtime: 1 }),
    });
    await c.openExternalAndPause();
    expect(handleEditorKey(c, char("z"))).toEqual({ kind: "resume" });
    expect(handleEditorKey(c, { type: "enter" })).toEqual({ kind: "resume" });
  });
});

describe("runDraftWithCancel — 取消立即响应(不等后台 LLM)", () => {
  const fakeStream = (keys: KeyEvent[]): KeyEventStream => {
    let i = 0;
    return {
      start() {},
      stop() {},
      drain() {},
      next: async () => keys[Math.min(i++, keys.length - 1)] as KeyEvent,
    };
  };

  it("起草中 Ctrl+C → 立即回 editing 重画,不阻塞等后台返回", async () => {
    // edit 永不 settle:模拟慢 / 卡住的后台 LLM。取消必须立即返回,否则此测试会超时
    // —— 直接守住"放弃等待"语义(回归此 race loop 时第一道防线)。
    const c = new SkillEditorController({
      edit: () => new Promise<SkillDraft>(() => {}),
      save: async () => {},
      autoDraft: false,
    });
    const phases: string[] = [];
    await runDraftWithCancel(c, "记下做法", fakeStream([{ type: "ctrl-c" }]), () =>
      phases.push(c.view().phase),
    );
    expect(c.view().phase).toBe("editing");
    expect(phases[0]).toBe("drafting"); // 开头画过"起草中"
    expect(phases).toContain("editing"); // 取消后立即重画 editing
  });
});
