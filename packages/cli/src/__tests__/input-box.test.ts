import { describe, it, expect } from "vitest";
import { stripAnsi, ANSI } from "../tui/index.js";
import { renderInputBox } from "../input-box.js";

describe("renderInputBox", () => {
  it("只渲染标题和框，信息行由场景的公共容器承接", () => {
    const r = renderInputBox({
      title: "新建",
      draft: "",
      cursor: 0,
      width: 50,
    });
    expect(r.lines.length).toBe(4);
    const joined = stripAnsi(r.lines.join("\n"));
    expect(joined).toContain("新建");
    expect(joined).not.toContain("Enter 提交");
  });

  it("标题 + 框 = 4 行", () => {
    const r = renderInputBox({ title: "x", draft: "", cursor: 0, width: 50 });
    expect(r.lines.length).toBe(4);
  });

  it("titleGlyph 替换默认 ▎ 标题前缀(动效帧替换用),框结构不变", () => {
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

  it("输入字符不会改变单行框的高度", () => {
    const r = renderInputBox({
      title: "x",
      draft: "",
      cursor: 0,
      width: 50,
    });
    const filled = renderInputBox({ title: "x", draft: "中", cursor: 1, width: 50 });
    expect(filled.lines.length).toBe(r.lines.length);
  });

  it.each(["abcdefghijklmnopqrs", "中文中文中文中文中a"])("满行保留软件光标且不裁掉正文：%s", draft => {
    const r = renderInputBox({ title: "x", draft, cursor: Array.from(draft).length, width: 24 });
    const row = r.lines[r.cursor.row]!;
    expect(row).toContain(`${ANSI.reverseOn} ${ANSI.reverseOff}`);
    expect(stripAnsi(row)).toContain(draft);
    expect(r.cursor.col).toBe(21);
  });

  it("非空 draft → 显示实际文本", () => {
    const r = renderInputBox({
      title: "x",
      draft: "已有内容",
      cursor: 4,
      width: 50,
    });
    const joined = stripAnsi(r.lines.join("\n"));
    expect(joined).toContain("已有内容");
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

  it("窄视口不被最小框宽扩大", () => {
    const narrow = renderInputBox({
      title: "x",
      draft: "",
      cursor: 0,
      width: 10,
    });
    const atMin = renderInputBox({
      title: "x",
      draft: "",
      cursor: 0,
      width: 40,
    });
    expect(stripAnsi(narrow.lines[1]!).length).toBe(10);
    expect(stripAnsi(atMin.lines[1]!).length).toBe(40);
  });
});
