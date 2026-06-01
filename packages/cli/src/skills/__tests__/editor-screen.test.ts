import { describe, it, expect } from "vitest";
import {
  stripAnsi,
  type KeyEvent,
  type KeyEventStream,
} from "../../tui/index.js";
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

const plain = (
  v: SkillEditorView,
  opts: { spinnerChar?: string; libraryEmpty?: boolean } = {},
): string => stripAnsi(renderSkillEditor(v, 80, "新建技能", opts).join("\n"));

const view = (over: Partial<SkillEditorView>): SkillEditorView => ({
  draft: null,
  input: "",
  inputCursor: 0,
  phase: "editing",
  error: null,
  canExternal: false,
  subject: "",
  redactionCount: 0,
  pendingDiscard: false,
  revisions: 0,
  ...over,
});

describe("renderSkillEditor", () => {
  it("等意图态(无草稿)→ 开场 + 输入框;库为空顶认知解释", () => {
    const out = plain(view({}), { libraryEmpty: true });
    expect(out).toContain("想收个什么技能");
    expect(out).toContain("技能 = 教我一次");
  });

  it("库非空 → 不顶认知解释", () => {
    expect(plain(view({}), { libraryEmpty: false })).not.toContain(
      "技能 = 教我一次",
    );
  });

  it("策展态(有草稿)→ 收自 + 字段(什么时候用)+ 正文 + 教学『我来改』", () => {
    const out = plain(view({ draft: draftA, subject: "收部署做法" }));
    expect(out).toContain("收自：收部署做法");
    expect(out).toContain("部署服务"); // 名称
    expect(out).toContain("什么时候用"); // 白话标签
    expect(out).toContain("先 build 再推镜像"); // 正文
    expect(out).toContain("我来改"); // 教学:打字=指挥 AI
  });

  it("脱敏可见:redactionCount>0 才显示抹掉提示", () => {
    expect(plain(view({ draft: draftA, redactionCount: 2 }))).toContain(
      "已自动抹掉对话里的 2 处密钥",
    );
    expect(plain(view({ draft: draftA, redactionCount: 0 }))).not.toContain(
      "已自动抹掉",
    );
  });

  it("模式降为白话灰字、顶栏不暴露 own/ 内部目录", () => {
    const out = plain(view({ draft: draftA })); // mode work
    expect(out).toContain("归到工作场景");
    expect(out).not.toContain("own/");
    expect(out).not.toContain("落点");
  });

  it("放弃二次确认态 → 确认行(含改了 N 轮)", () => {
    const out = plain(view({ draft: draftA, pendingDiscard: true, revisions: 3 }));
    expect(out).toContain("放弃这份草稿");
    expect(out).toContain("改了 3 轮");
  });

  it("显影态(首次,无草稿)→ 收自 + 骨架占位,无矛盾引导", () => {
    const out = plain(view({ phase: "drafting", subject: "部署流程" }));
    expect(out).toContain("收自：部署流程");
    expect(out).toContain("正在写");
    expect(out).toContain("░"); // 骨架
    expect(out).not.toContain("还没有草稿"); // 旧矛盾引导已消除
  });

  it("显影态 subject 空(纯对话提炼)→ 顶部显示提炼中占位、不露空『收自：』", () => {
    const out = plain(view({ phase: "drafting", subject: "" }));
    expect(out).toContain("正在从最近的对话里提炼");
    expect(out).not.toContain("收自："); // 空 subject 不渲染空字段
  });

  it("显影态(改写,有草稿)→ 保留现草稿 + 增量语气", () => {
    const out = plain(view({ phase: "drafting", draft: draftA, subject: "x" }));
    expect(out).toContain("正在按你说的改");
    expect(out).toContain("部署服务"); // 现草稿保留
    expect(out).toContain("原来的会留着");
  });

  it("external 态 → 提示读回", () => {
    const out = plain(view({ phase: "external", draft: draftA, subject: "x" }));
    expect(out).toContain("已用你的编辑器打开");
    expect(out).toContain("按任意键读回");
  });

  it("起草失败(无草稿 + error)→ 友好重试文案、不露开发者黑话", () => {
    const out = plain(view({ error: "起草失败:模型未返回 JSON 草稿" }));
    expect(out).toContain("偶尔会抽风");
    expect(out).not.toContain("模型未返回 JSON");
  });

  it("spinnerChar 注入 → 显影态渲染该帧", () => {
    expect(plain(view({ phase: "drafting", subject: "x" }), { spinnerChar: "▣" })).toContain(
      "▣",
    );
  });
});

const draftResult = { draft: draftA, subject: "AI主题", redactionCount: 0 };
const mk = (over: Partial<SkillEditorDeps> = {}): SkillEditorController =>
  new SkillEditorController({
    draft: async () => draftResult,
    revise: async () => ({ draft: draftA, redactionCount: 0 }),
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
  });

  it("回车 + 非空输入 → submit 并清空;空输入 → continue", () => {
    const c = mk();
    handleEditorKey(c, char("改"));
    handleEditorKey(c, char("尖"));
    expect(handleEditorKey(c, { type: "enter" })).toEqual({
      kind: "submit",
      instruction: "改尖",
    });
    expect(c.view().input).toBe("");
    expect(handleEditorKey(mk(), { type: "enter" })).toEqual({ kind: "continue" });
  });

  it("Ctrl+S:有草稿 → save;无草稿 → continue", async () => {
    expect(handleEditorKey(mk(), { type: "ctrl-s" })).toEqual({ kind: "continue" });
    expect(handleEditorKey(await seeded(), { type: "ctrl-s" })).toEqual({
      kind: "save",
    });
  });

  it("Ctrl+E 放宽:canExternal 即可进外部编辑(无草稿也行,手写直通车)", () => {
    const withExt = mk({ openExternal: async () => ({ file: "/tmp/x", mtime: 1 }) });
    expect(handleEditorKey(withExt, { type: "ctrl-e" })).toEqual({
      kind: "external",
    }); // 还没起草也能进
    expect(handleEditorKey(mk(), { type: "ctrl-e" })).toEqual({ kind: "continue" }); // 没注入 openExternal
  });

  it("Esc 分层:输入非空→清空(continue);为空且无草稿→cancel", () => {
    const c = mk();
    handleEditorKey(c, char("半"));
    handleEditorKey(c, char("句"));
    expect(handleEditorKey(c, { type: "escape" })).toEqual({ kind: "continue" });
    expect(c.view().input).toBe(""); // 第一次 Esc 清空输入
    expect(handleEditorKey(c, { type: "escape" })).toEqual({ kind: "cancel" }); // 再 Esc:空+无草稿→退
  });

  it("Esc:为空且有草稿 → 先二次确认(continue),再按 → cancel", async () => {
    const c = await seeded();
    expect(handleEditorKey(c, { type: "escape" })).toEqual({ kind: "continue" });
    expect(c.view().pendingDiscard).toBe(true);
    expect(handleEditorKey(c, { type: "escape" })).toEqual({ kind: "cancel" });
  });

  it("非 Esc 键解除放弃确认(确认行不黏住)", async () => {
    const c = await seeded();
    handleEditorKey(c, { type: "escape" }); // 进确认
    expect(c.view().pendingDiscard).toBe(true);
    handleEditorKey(c, char("x")); // 任意键
    expect(c.view().pendingDiscard).toBe(false);
  });

  it("Ctrl+C → 直接 cancel(强终端语义、底层兜底)", () => {
    expect(handleEditorKey(mk(), { type: "ctrl-c" })).toEqual({ kind: "cancel" });
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
    // draft 永不 settle:模拟慢 / 卡住的后台 LLM。取消必须立即返回,否则此测试会超时。
    const c = new SkillEditorController({
      draft: () => new Promise(() => {}),
      revise: async () => ({ draft: draftA, redactionCount: 0 }),
      save: async () => {},
      autoDraft: false,
    });
    const phases: string[] = [];
    await runDraftWithCancel(c, "记下做法", fakeStream([{ type: "ctrl-c" }]), () =>
      phases.push(c.view().phase),
    );
    expect(c.view().phase).toBe("editing");
    expect(phases[0]).toBe("drafting"); // 开头画过显影态
    expect(phases).toContain("editing"); // 取消后立即重画 editing
  });
});
