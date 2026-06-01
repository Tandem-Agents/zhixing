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
    draft: async () => ({ draft: draftA, subject: "AI主题", redactionCount: 0 }),
    revise: async () => ({ draft: draftA, redactionCount: 0 }),
    save: async () => {},
    autoDraft: false,
    ...over,
  });

const sig = (): AbortSignal => new AbortController().signal;

describe("SkillEditorController — 起草 / 改写", () => {
  it("首次起草成功 → 换草稿、回 editing、清错;收自=用户意图(明说优先)", async () => {
    const c = mk();
    await c.runEdit("记下部署做法", sig());
    expect(c.view().draft).toEqual(draftA);
    expect(c.view().phase).toBe("editing");
    expect(c.view().error).toBeNull();
    expect(c.view().subject).toBe("记下部署做法"); // 用户明说优先
    expect(c.view().revisions).toBe(0);
  });

  it("首次起草不带意图(autoDraft 空指令)→ 收自=AI 主题", async () => {
    const c = mk();
    await c.runEdit("", sig());
    expect(c.view().subject).toBe("AI主题");
  });

  it("带意图:显影期间(LLM 未返回)收自已是用户原话、不空", async () => {
    let resolve!: (r: { draft: SkillDraft; subject: string; redactionCount: number }) => void;
    const c = mk({ draft: () => new Promise((r) => { resolve = r; }) });
    const ac = new AbortController();
    const p = c.runEdit("把部署流程收下来", ac.signal);
    expect(c.view().phase).toBe("drafting");
    expect(c.view().subject).toBe("把部署流程收下来"); // 开头即设,不等 LLM
    resolve({ draft: draftA, subject: "AI主题", redactionCount: 0 });
    await p;
    expect(c.view().subject).toBe("把部署流程收下来"); // 意图优先,不被 AI 覆盖
  });

  it("无意图:显影期间收自空,LLM 返回后才用 AI 主题补上", async () => {
    let resolve!: (r: { draft: SkillDraft; subject: string; redactionCount: number }) => void;
    const c = mk({ draft: () => new Promise((r) => { resolve = r; }) });
    const ac = new AbortController();
    const p = c.runEdit("", ac.signal);
    expect(c.view().subject).toBe(""); // 显影中空,渲染层显示"提炼中"占位
    resolve({ draft: draftA, subject: "AI判定主题", redactionCount: 0 });
    await p;
    expect(c.view().subject).toBe("AI判定主题");
  });

  it("脱敏计数透出到 view", async () => {
    const c = mk({
      draft: async () => ({ draft: draftA, subject: "s", redactionCount: 2 }),
    });
    await c.runEdit("x", sig());
    expect(c.view().redactionCount).toBe(2);
  });

  it("已有草稿再 runEdit → 走 revise、revisions++、subject 不变", async () => {
    let revised = 0;
    const c = mk({
      revise: async () => {
        revised++;
        return { draft: { ...draftA, body: "改后" }, redactionCount: 0 };
      },
    });
    await c.runEdit("首次意图", sig()); // draft：subject=首次意图
    await c.runEdit("改简洁点", sig()); // revise
    expect(revised).toBe(1);
    expect(c.view().revisions).toBe(1);
    expect(c.view().draft?.body).toBe("改后");
    expect(c.view().subject).toBe("首次意图"); // 改写不换主题
  });

  it("失败 → 记错、留原草稿(无)、回 editing、把意图预填回输入框", async () => {
    const c = mk({
      draft: async () => {
        throw new Error("起草失败:模型未返回 JSON 草稿");
      },
    });
    await c.runEdit("记下部署做法", sig());
    expect(c.view().draft).toBeNull();
    expect(c.view().error).toContain("起草失败");
    expect(c.view().phase).toBe("editing");
    expect(c.view().input).toBe("记下部署做法"); // 失败预填、不丢意图
  });

  it("放弃等待(signal 已 abort)→ 结果丢弃、不污染草稿", async () => {
    let resolve!: (r: { draft: SkillDraft; subject: string; redactionCount: number }) => void;
    const c = mk({
      draft: () =>
        new Promise((r) => {
          resolve = r;
        }),
    });
    const ac = new AbortController();
    const p = c.runEdit("x", ac.signal);
    ac.abort();
    resolve({ draft: draftA, subject: "s", redactionCount: 0 });
    await p;
    expect(c.view().draft).toBeNull();
    expect(c.view().error).toBeNull();
  });
});

describe("SkillEditorController — 取消落点", () => {
  it("首次起草中途取消 → 落回等意图态、意图预填回输入框(不进空屏黑洞)", async () => {
    let resolve!: (r: { draft: SkillDraft; subject: string; redactionCount: number }) => void;
    const c = mk({
      draft: () =>
        new Promise((r) => {
          resolve = r;
        }),
    });
    const ac = new AbortController();
    const p = c.runEdit("我想收的事", ac.signal);
    c.cancelDraft(); // 用户中途按 Ctrl+C
    ac.abort();
    resolve({ draft: draftA, subject: "s", redactionCount: 0 });
    await p;
    expect(c.view().draft).toBeNull();
    expect(c.view().phase).toBe("editing");
    expect(c.view().input).toBe("我想收的事"); // 预填,接住"我刚说的还在"
  });

  it("改写中途取消 → 保留原草稿、不预填", async () => {
    let resolve!: (r: { draft: SkillDraft; redactionCount: number }) => void;
    const c = mk({
      revise: () =>
        new Promise((r) => {
          resolve = r;
        }),
    });
    await c.runEdit("首次", sig()); // 先有草稿
    const ac = new AbortController();
    const p = c.runEdit("改一下", ac.signal);
    c.cancelDraft();
    ac.abort();
    resolve({ draft: draftA, redactionCount: 0 });
    await p;
    expect(c.view().draft).toEqual(draftA); // 原草稿保留
    expect(c.view().input).toBe(""); // 有草稿,不预填
  });
});

describe("SkillEditorController — Esc 分层(pressEscape)", () => {
  it("输入框非空 → 先清空输入、不退(cleared-input)", () => {
    const c = mk();
    c.typeChar("半");
    c.typeChar("句");
    expect(c.pressEscape()).toBe("cleared-input");
    expect(c.view().input).toBe("");
  });

  it("输入空 + 无草稿 → 直接退(exit)", () => {
    const c = mk();
    expect(c.pressEscape()).toBe("exit");
  });

  it("输入空 + 有草稿 → 先二次确认,再按才放弃", async () => {
    const c = mk();
    await c.runEdit("x", sig()); // 有草稿
    expect(c.pressEscape()).toBe("confirm-discard");
    expect(c.view().pendingDiscard).toBe(true);
    expect(c.pressEscape()).toBe("discard"); // 第二次
  });

  it("resetDiscard 解除待确认(非 Esc 操作后确认行不黏住)", async () => {
    const c = mk();
    await c.runEdit("x", sig());
    c.pressEscape(); // 进确认
    expect(c.view().pendingDiscard).toBe(true);
    c.resetDiscard();
    expect(c.view().pendingDiscard).toBe(false);
  });
});

describe("SkillEditorController — 保存", () => {
  it("save 把当前草稿交给注入 writer", async () => {
    const saved: SkillDraft[] = [];
    const c = mk({ save: async (d) => void saved.push(d) });
    await c.runEdit("x", sig());
    await c.save();
    expect(saved).toEqual([draftA]);
  });
});

describe("SkillEditorController — 外部编辑两路衔接", () => {
  it("打开 → 进 external 暂停态", async () => {
    const c = mk({
      openExternal: async () => ({ file: "/tmp/SKILL.md", mtime: 100, opened: true }),
    });
    await c.runEdit("x", sig());
    await c.openExternalAndPause();
    expect(c.view().phase).toBe("external");
  });

  it("手写直通车:无草稿也能进外部编辑(传 null)", async () => {
    let receivedNull = false;
    const c = mk({
      openExternal: async (d) => {
        receivedNull = d === null;
        return { file: "/tmp/SKILL.md", mtime: 100, opened: true };
      },
    });
    await c.openExternalAndPause(); // 还没起草
    expect(receivedNull).toBe(true);
    expect(c.view().phase).toBe("external");
  });

  it("回屏:mtime 变了重读换草稿", async () => {
    const draftB: SkillDraft = { ...draftA, body: "外部改过的正文" };
    const c = mk({
      openExternal: async () => ({ file: "/tmp/SKILL.md", mtime: 100, opened: true }),
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
      openExternal: async () => ({ file: "/tmp/SKILL.md", mtime: 100, opened: true }),
      rereadExternal: async () => null,
    });
    await c.runEdit("x", sig());
    await c.openExternalAndPause();
    await c.resumeFromExternal();
    expect(c.view().draft).toEqual(draftA);
    expect(c.view().phase).toBe("editing");
  });

  it("未注入 openExternal → canExternal=false、不进暂停态", async () => {
    const c = mk();
    await c.runEdit("x", sig());
    expect(c.view().canExternal).toBe(false);
    await c.openExternalAndPause();
    expect(c.view().phase).toBe("editing");
  });

  it("自动打开失败(opened:false)→ 仍进 external 态、view 暴露文件路径供手动打开", async () => {
    const c = mk({
      openExternal: async () => ({
        file: "/tmp/SKILL.md",
        mtime: 100,
        opened: false,
      }),
    });
    await c.runEdit("x", sig());
    await c.openExternalAndPause();
    expect(c.view().phase).toBe("external"); // 不退回编辑屏,顺着外部编辑意图
    expect(c.view().external).toEqual({ file: "/tmp/SKILL.md", opened: false });
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

  it("光标:moveCursorLeft 后插入落到光标处(中间插入)", () => {
    const c = mk();
    c.typeChar("a");
    c.typeChar("c");
    expect(c.view().inputCursor).toBe(2);
    c.moveCursorLeft();
    expect(c.view().inputCursor).toBe(1);
    c.typeChar("b");
    expect(c.view().input).toBe("abc");
    expect(c.view().inputCursor).toBe(2);
  });

  it("CJK:中文按字符 offset 计光标(非 UTF-16)", () => {
    const c = mk();
    c.typeChar("中");
    c.typeChar("文");
    expect(c.view().input).toBe("中文");
    expect(c.view().inputCursor).toBe(2);
    c.moveCursorLeft();
    c.typeChar("简");
    expect(c.view().input).toBe("中简文");
    expect(c.view().inputCursor).toBe(2);
  });

  it("takeInput 后光标归零", () => {
    const c = mk();
    c.typeChar("x");
    c.typeChar("y");
    c.takeInput();
    expect(c.view().input).toBe("");
    expect(c.view().inputCursor).toBe(0);
  });
});
