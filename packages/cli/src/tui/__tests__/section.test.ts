import { describe, expect, it } from "vitest";
import { renderEntryRow, renderSectionHead } from "../section.js";
import { stripAnsi } from "../ansi.js";
import { stringWidth } from "../line-width.js";

describe("renderSectionHead", () => {
  it("只有标题时返回单行，含 ◆ + 标题", () => {
    const lines = renderSectionHead({ title: "对话模型" });
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0]!)).toContain("◆");
    expect(stripAnsi(lines[0]!)).toContain("对话模型");
  });

  it("含描述时返回两行", () => {
    const lines = renderSectionHead({
      title: "对话模型",
      description: "主模型必填",
    });
    expect(lines).toHaveLength(2);
    expect(stripAnsi(lines[1]!)).toContain("主模型必填");
  });
});

describe("renderEntryRow", () => {
  it("未选中时无 cursor 字符（占位空格）", () => {
    const line = renderEntryRow({
      label: "主模型",
      status: { kind: "pending", text: "待补" },
      width: 60,
    });
    expect(stripAnsi(line)).not.toMatch(/▸/);
  });

  it("选中时 cursor ▸ 出现在左侧", () => {
    const line = renderEntryRow({
      label: "主模型",
      status: { kind: "pending", text: "待补" },
      selected: true,
      width: 60,
    });
    expect(stripAnsi(line)).toMatch(/▸\s+主模型/);
  });

  it("行总宽不超过 width（pill 右对齐）", () => {
    const line = renderEntryRow({
      label: "主模型",
      status: { kind: "ready", text: "siliconflow · MiniMax-M2.5" },
      width: 80,
    });
    expect(stringWidth(line)).toBeLessThanOrEqual(80);
  });

  it("CJK label 与 pill 间隔不小于 2", () => {
    const line = renderEntryRow({
      label: "辅助模型",
      status: { kind: "disabled", text: "未启用" },
      width: 60,
    });
    const visible = stripAnsi(line);
    // 必须含至少 2 连续空格作为 label 与 pill 间的分隔
    expect(visible).toMatch(/\s{2,}/);
  });
});
