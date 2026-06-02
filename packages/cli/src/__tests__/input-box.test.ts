import { describe, it, expect } from "vitest";
import { stripAnsi, ANSI } from "../tui/index.js";
import { renderInputBox } from "../input-box.js";

describe("renderInputBox", () => {
  it("结构:标题(1) + 框(3) + hint(1) = 5 行", () => {
    const r = renderInputBox({
      title: "新建",
      draft: "",
      cursor: 0,
      hint: "Enter 提交",
      width: 50,
    });
    expect(r.lines.length).toBe(5);
    const joined = stripAnsi(r.lines.join("\n"));
    expect(joined).toContain("新建");
    expect(joined).toContain("Enter 提交");
  });

  it("省略 hint → 无 hint 行(标题 + 框 = 4 行)", () => {
    const r = renderInputBox({ title: "x", draft: "", cursor: 0, width: 50 });
    expect(r.lines.length).toBe(4);
  });

  it("titleGlyph 替换默认 ▎ 标题前缀(drafting 换笔用),框结构不变", () => {
    const def = renderInputBox({ title: "想怎么改", draft: "", cursor: 0, width: 50 });
    const pen = renderInputBox({
      title: "奋笔疾书中",
      draft: "",
      cursor: 0,
      width: 50,
      titleGlyph: "P!",
    });
    expect(stripAnsi(def.lines[0]!)).toContain("▎"); // 默认 ▎ 章节锚
    expect(stripAnsi(pen.lines[0]!)).toContain("P!"); // 自定义替换
    expect(stripAnsi(pen.lines[0]!)).not.toContain("▎");
    expect(pen.lines.length).toBe(def.lines.length); // 框结构不变
  });

  it("hintBar:框下结构化提示行(说明 键、左右分区),共 5 行", () => {
    const r = renderInputBox({
      title: "新建",
      draft: "",
      cursor: 0,
      width: 60,
      hintBar: {
        hints: [{ label: "放弃", key: "Esc" }],
        rightHints: [{ label: "提交", key: "Enter" }],
      },
    });
    expect(r.lines.length).toBe(5); // 标题 + 框(3) + hintBar(1)
    const joined = stripAnsi(r.lines.join("\n"));
    expect(joined).toContain("放弃 Esc");
    expect(joined).toContain("提交 Enter");
  });

  it("hintBar 优先于 hint(同时传时只画 hintBar)", () => {
    const r = renderInputBox({
      title: "x",
      draft: "",
      cursor: 0,
      width: 60,
      hint: "旧提示文本",
      hintBar: { hints: [{ label: "提交", key: "Enter" }] },
    });
    const joined = stripAnsi(r.lines.join("\n"));
    expect(joined).toContain("提交 Enter");
    expect(joined).not.toContain("旧提示文本");
  });

  it("空 draft + placeholder → 框内显示占位", () => {
    const r = renderInputBox({
      title: "x",
      draft: "",
      cursor: 0,
      placeholder: "请输入",
      width: 50,
    });
    expect(stripAnsi(r.lines.join("\n"))).toContain("请输入");
  });

  it("非空 draft → 显示文本、不显示 placeholder", () => {
    const r = renderInputBox({
      title: "x",
      draft: "已有内容",
      cursor: 4,
      placeholder: "请输入",
      width: 50,
    });
    const joined = stripAnsi(r.lines.join("\n"));
    expect(joined).toContain("已有内容");
    expect(joined).not.toContain("请输入");
  });

  it("软件光标:cursor 位置用 reverse SGR 渲染", () => {
    const r = renderInputBox({ title: "x", draft: "ab", cursor: 1, width: 50 });
    expect(r.lines.join("")).toContain(ANSI.reverseOn);
  });

  it("cursor 坐标:单行输入落在框内行(row=2)", () => {
    const r = renderInputBox({ title: "x", draft: "ab", cursor: 2, width: 50 });
    // 标题(row 0) + 框顶边(row 1) → 输入行(row 2)
    expect(r.cursor.row).toBe(2);
    expect(r.cursor.col).toBeGreaterThanOrEqual(2);
  });

  it("CJK:中文 draft 完整渲染、不崩", () => {
    const r = renderInputBox({
      title: "标题",
      draft: "中文输入",
      cursor: 2,
      width: 50,
    });
    expect(stripAnsi(r.lines.join("\n"))).toContain("中文输入");
  });

  it("minWidth 兜底:width < minWidth 时框宽用 minWidth", () => {
    const narrow = renderInputBox({
      title: "x",
      draft: "",
      cursor: 0,
      width: 10,
      minWidth: 40,
    });
    const atMin = renderInputBox({
      title: "x",
      draft: "",
      cursor: 0,
      width: 40,
      minWidth: 40,
    });
    // 两者框宽都 = 40，顶边可见宽度一致
    expect(stripAnsi(narrow.lines[1]!).length).toBe(
      stripAnsi(atMin.lines[1]!).length,
    );
  });
});
