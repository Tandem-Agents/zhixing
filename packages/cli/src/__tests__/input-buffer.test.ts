/**
 * InputBuffer 单元测试
 *
 * 覆盖点：
 *   - 基本 CRUD（insert/delete/replaceRange/clear/setDraft）
 *   - Cursor 移动 + clamp
 *   - CJK / emoji（字符 offset 不是 UTF-16 code unit）
 *   - History 浏览 + savedDraft 回退
 *   - toTriggerContext 派生正确
 */

import { describe, expect, it } from "vitest";
import type { RuntimeContext } from "@zhixing/core";
import { InputBuffer } from "../input-buffer.js";

function makeRuntime(): RuntimeContext {
  return {
    sessionBusy: false,
    workspaceId: null,
    cwd: "/tmp",
    target: "cli",
    features: {},
    now: 1_700_000_000_000,
  };
}

describe("InputBuffer — 基本编辑", () => {
  it("初始为空", () => {
    const b = new InputBuffer();
    expect(b.draft).toBe("");
    expect(b.cursor).toBe(0);
    expect(b.isEmpty).toBe(true);
  });

  it("insertText 追加到 cursor 后并推进 cursor", () => {
    const b = new InputBuffer();
    b.insertText("hello");
    expect(b.draft).toBe("hello");
    expect(b.cursor).toBe(5);
  });

  it("insertText 在 cursor 中间插入", () => {
    const b = new InputBuffer();
    b.insertText("hello");
    b.moveCursorHome();
    b.insertText(">> ");
    expect(b.draft).toBe(">> hello");
    expect(b.cursor).toBe(3);
  });

  it("deleteBackward 删 cursor 左一个字符", () => {
    const b = new InputBuffer();
    b.insertText("abc");
    b.deleteBackward();
    expect(b.draft).toBe("ab");
    expect(b.cursor).toBe(2);
  });

  it("deleteBackward 在 cursor=0 时是 no-op", () => {
    const b = new InputBuffer();
    b.insertText("abc");
    b.moveCursorHome();
    b.deleteBackward();
    expect(b.draft).toBe("abc");
    expect(b.cursor).toBe(0);
  });

  it("deleteForward 删 cursor 右一个字符", () => {
    const b = new InputBuffer();
    b.insertText("abc");
    b.moveCursorHome();
    b.deleteForward();
    expect(b.draft).toBe("bc");
    expect(b.cursor).toBe(0);
  });

  it("clear 清空整行并归零 cursor", () => {
    const b = new InputBuffer();
    b.insertText("abc");
    b.clear();
    expect(b.draft).toBe("");
    expect(b.cursor).toBe(0);
  });

  it("setDraft 整体替换并可设置 cursor", () => {
    const b = new InputBuffer();
    b.setDraft("/new", 2);
    expect(b.draft).toBe("/new");
    expect(b.cursor).toBe(2);
  });

  it("setDraft 不带 cursor 落到末尾", () => {
    const b = new InputBuffer();
    b.setDraft("hello");
    expect(b.cursor).toBe(5);
  });

  it("replaceRange 替换区间并把 cursor 放到替换尾", () => {
    const b = new InputBuffer();
    b.insertText("hello world");
    b.replaceRange(6, 11, "there");
    expect(b.draft).toBe("hello there");
    expect(b.cursor).toBe(11);
  });
});

describe("InputBuffer — Cursor 移动", () => {
  it("左右移动在 [0, length] 内 clamp", () => {
    const b = new InputBuffer();
    b.insertText("abc");
    b.moveCursorRight(); // no-op at end
    expect(b.cursor).toBe(3);
    b.moveCursorLeft();
    expect(b.cursor).toBe(2);
    b.moveCursorHome();
    expect(b.cursor).toBe(0);
    b.moveCursorLeft(); // no-op at 0
    expect(b.cursor).toBe(0);
    b.moveCursorEnd();
    expect(b.cursor).toBe(3);
  });
});

describe("InputBuffer — CJK / emoji 字符安全", () => {
  it("中文 draft 的 cursor 按字符计数", () => {
    const b = new InputBuffer();
    b.insertText("你好世界");
    expect(b.draft).toBe("你好世界");
    expect(b.cursor).toBe(4);
    b.moveCursorLeft();
    b.deleteBackward();
    expect(b.draft).toBe("你好界");
  });

  it("emoji 代理对作为单字符处理", () => {
    const b = new InputBuffer();
    b.insertText("hi🚀");
    expect(b.cursor).toBe(3); // h,i,🚀 = 3 字符
    b.deleteBackward();
    expect(b.draft).toBe("hi");
  });
});

describe("InputBuffer — History", () => {
  it("commit 把 draft 推入历史并清空", () => {
    const b = new InputBuffer();
    b.insertText("line1");
    const s = b.commit();
    expect(s).toBe("line1");
    expect(b.draft).toBe("");
    expect(b.getHistory()).toEqual(["line1"]);
  });

  it("historyPrev 回到上一条", () => {
    const b = new InputBuffer();
    b.insertText("line1");
    b.commit();
    b.insertText("line2");
    b.commit();
    b.historyPrev();
    expect(b.draft).toBe("line2");
    b.historyPrev();
    expect(b.draft).toBe("line1");
  });

  it("historyPrev 到头后不再后退", () => {
    const b = new InputBuffer();
    b.insertText("a");
    b.commit();
    b.historyPrev();
    b.historyPrev();
    expect(b.draft).toBe("a");
  });

  it("historyNext 走到末尾恢复 savedDraft", () => {
    const b = new InputBuffer();
    b.insertText("past");
    b.commit();
    b.insertText("current");
    b.historyPrev();
    expect(b.draft).toBe("past");
    b.historyNext();
    expect(b.draft).toBe("current");
  });

  it("提交空 draft 不进历史", () => {
    const b = new InputBuffer();
    b.commit();
    expect(b.getHistory()).toEqual([]);
  });

  it("historyLimit 裁剪", () => {
    const b = new InputBuffer({ historyLimit: 3 });
    for (const s of ["a", "b", "c", "d", "e"]) {
      b.insertText(s);
      b.commit();
    }
    expect(b.getHistory()).toEqual(["c", "d", "e"]);
  });

  it("getRestorableDraftSlots 返回稳定槽位、历史和浏览前草稿", () => {
    const b = new InputBuffer();
    b.insertText("history one");
    b.commit();
    b.insertText("history two");
    b.commit();
    b.insertText("current draft");

    expect(b.getRestorableDraftSlots()).toEqual([
      { key: "current", draft: "current draft" },
      { key: "history:1", draft: "history one" },
      { key: "history:2", draft: "history two" },
    ]);

    b.historyPrev();
    expect(b.draft).toBe("history two");
    expect(b.getRestorableDraftSlots()).toEqual([
      { key: "history:1", draft: "history one" },
      { key: "history:2", draft: "history two" },
      { key: "saved-draft", draft: "current draft" },
    ]);

    b.historyNext();
    expect(b.draft).toBe("current draft");
    expect(b.getRestorableDraftSlots()).toEqual([
      { key: "current", draft: "current draft" },
      { key: "history:1", draft: "history one" },
      { key: "history:2", draft: "history two" },
    ]);
  });

  it("getRestorableDraftSlots 遵守 historyLimit 淘汰边界", () => {
    const b = new InputBuffer({ historyLimit: 2 });
    for (const s of ["old", "middle", "new"]) {
      b.insertText(s);
      b.commit();
    }

    expect(b.getRestorableDraftSlots()).toEqual([
      { key: "history:2", draft: "middle" },
      { key: "history:3", draft: "new" },
    ]);
  });
});

describe("InputBuffer — toTriggerContext", () => {
  it("派生当前 draft + cursor + runtime", () => {
    const b = new InputBuffer();
    b.insertText("/ne");
    const ctx = b.toTriggerContext(makeRuntime());
    expect(ctx.draft).toBe("/ne");
    expect(ctx.cursor).toBe(3);
    expect(ctx.mode).toBe("prompt");
    expect(ctx.runtime.cwd).toBe("/tmp");
  });
});
