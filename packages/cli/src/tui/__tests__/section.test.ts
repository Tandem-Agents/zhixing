import { describe, expect, it } from "vitest";
import chalk from "chalk";
import { renderEntryRow, renderListRow, renderSectionHead } from "../section.js";
import { stripAnsi } from "../ansi.js";
import { stringWidth } from "../line-width.js";

// vitest stdout 非 TTY，chalk 默认不染色——强开以验证 bg 高亮等颜色相关结构
chalk.level = 3;

describe("renderSectionHead", () => {
  it("只有标题时返回单行：` ▎ 标题`——title 文字落在 col 3（半字层级）", () => {
    const lines = renderSectionHead({ title: "对话模型" });
    expect(lines).toHaveLength(1);
    // 1 space + ▎ + space + title——title 文字位于 col 3
    expect(stripAnsi(lines[0]!).startsWith(" ▎ 对话模型")).toBe(true);
  });

  it("含描述时返回 3 行——title、空行、description", () => {
    const lines = renderSectionHead({
      title: "对话模型",
      description: "主模型必填",
    });
    expect(lines).toHaveLength(3);
    expect(stripAnsi(lines[1]!)).toBe(""); // 空行做层级分隔
    expect(stripAnsi(lines[2]!).startsWith("    主模型必填")).toBe(true);
  });

  it("含 status 时 pill 紧挨标题（非右对齐）", () => {
    const lines = renderSectionHead({
      title: "操作",
      status: { kind: "pending", text: "待补充 1 项" },
    });
    expect(lines).toHaveLength(1);
    // 形态：` ▎ 操作   ⚠ 待补充 1 项`——title 与 pill 间固定小间距
    expect(stripAnsi(lines[0]!)).toMatch(/^ ▎ 操作\s{3}⚠ 待补充 1 项$/);
  });

  it("含 status + description 返回 3 行（status 在 title 行；空行分层）", () => {
    const lines = renderSectionHead({
      title: "操作",
      description: "保存并启动 / 取消",
      status: { kind: "ready", text: "全部就绪" },
    });
    expect(lines).toHaveLength(3);
    expect(stripAnsi(lines[0]!)).toMatch(/^ ▎ 操作\s{3}✓ 全部就绪$/);
    expect(stripAnsi(lines[1]!)).toBe("");
    expect(stripAnsi(lines[2]!)).toContain("保存并启动 / 取消");
  });
});

describe("renderEntryRow", () => {
  it("未选中时左侧是 dim › 默认标记（不出现 ▸ cursor）", () => {
    const lines = renderEntryRow({
      label: "主模型",
      status: { kind: "pending", text: "待补" },
      width: 60,
    });
    const visible = stripAnsi(lines[0]!);
    expect(visible).not.toMatch(/▸/);
    expect(visible).toMatch(/›\s+主模型/);
  });

  it("选中时 cursor ▸ 出现在左侧 + 行内 padding 替换为 ░ 点阵纹理", () => {
    const lines = renderEntryRow({
      label: "主模型",
      status: { kind: "pending", text: "待补" },
      selected: true,
      width: 60,
    });
    const visible = stripAnsi(lines[0]!);
    // cursor + label 之间的单空格保留，但更长的 padding 段被替换为 ░
    expect(visible).toMatch(/▸ 主模型/);
    expect(visible).toContain("░");
    // 尾部 pad 到 width 也用 ░
    expect(stringWidth(visible)).toBe(60);
  });

  it("短 pill 单行容纳——pill 起始于左区右边界（width/2）", () => {
    const lines = renderEntryRow({
      label: "主模型",
      status: { kind: "disabled", text: "未启用" },
      width: 60,
    });
    expect(lines).toHaveLength(1);
    const visible = stripAnsi(lines[0]!);
    // pill 起始 visual col = leftZoneWidth = floor(60/2) = 30
    const beforePill = visible.slice(0, visible.indexOf("·"));
    expect(stringWidth(beforePill)).toBe(30);
  });

  it("长 pill 自动换行——续行从右区起始位左对齐", () => {
    const longText = "siliconflow · Pro/MiniMaxAI/MiniMax-M2.5 (待补 API Key)";
    const lines = renderEntryRow({
      label: "主模型",
      status: { kind: "pending", text: longText },
      width: 60,
    });
    expect(lines.length).toBeGreaterThan(1);
    // 续行：左区为空格，右区从 col 30 起
    const continuation = stripAnsi(lines[1]!);
    expect(continuation.slice(0, 30)).toBe(" ".repeat(30));
    expect(continuation.length).toBeGreaterThan(30);
  });

  it("不同长度的 pill 起始列对齐——靠左不靠右", () => {
    const a = renderEntryRow({
      label: "主模型",
      status: { kind: "ready", text: "siliconflow" },
      width: 60,
    });
    const b = renderEntryRow({
      label: "辅助模型",
      status: { kind: "disabled", text: "未启用" },
      width: 60,
    });
    // 两 pill 的 icon 都起始于 col 30（leftZoneWidth）
    const aVisible = stripAnsi(a[0]!);
    const bVisible = stripAnsi(b[0]!);
    expect(stringWidth(aVisible.slice(0, aVisible.indexOf("✓")))).toBe(30);
    expect(stringWidth(bVisible.slice(0, bVisible.indexOf("·")))).toBe(30);
  });
});

describe("renderListRow", () => {
  it("无 description 单行返回——cursor + label", () => {
    const lines = renderListRow({
      label: "硅基流动",
      width: 60,
    });
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0]!).trimEnd().endsWith("硅基流动")).toBe(true);
  });

  it("含 description 双区——right 起始于 col width/2 (左对齐)", () => {
    const lines = renderListRow({
      label: "硅基流动",
      description: "国内大模型聚合平台",
      width: 60,
    });
    const visible = stripAnsi(lines[0]!);
    // description 起始位置 = leftZoneWidth = 30
    const beforeDesc = visible.slice(0, visible.indexOf("国"));
    expect(stringWidth(beforeDesc)).toBe(30);
  });

  it("current=undefined 时无 marker 槽位（label 紧跟 cursor）", () => {
    const lines = renderListRow({
      label: "硅基流动",
      width: 60,
      // 不传 current
    });
    // cursor + space + label——visible col 4 起 label
    const visible = stripAnsi(lines[0]!);
    const labelStart = visible.indexOf("硅");
    expect(labelStart).toBe(4); // 2 indent + cursor + space = 4
  });

  it("current=false 时 marker 槽位为空格——label 起始列与 current=true 行对齐", () => {
    const noCurrent = renderListRow({
      label: "Model-A",
      current: false,
      width: 60,
    });
    const yesCurrent = renderListRow({
      label: "Model-B",
      current: true,
      width: 60,
    });
    // 两行 label 起始列必须一致
    const aLabelCol = stripAnsi(noCurrent[0]!).indexOf("M");
    const bLabelCol = stripAnsi(yesCurrent[0]!).indexOf("M");
    expect(aLabelCol).toBe(bLabelCol);
  });

  it("current=true 时 ● 出现在 cursor 之后", () => {
    const lines = renderListRow({
      label: "Model-A",
      current: true,
      width: 60,
    });
    // 形态：`  · ● Model-A` 或 `  ▸ ● Model-A`（取决于 selected）
    expect(stripAnsi(lines[0]!)).toMatch(/●\s+Model-A/);
  });

  it("长 description 自动换行——续行从右区起始位左对齐", () => {
    const longDesc =
      "这是一段非常长非常长非常长的说明，长到一行装不下需要换到下一行去显示";
    const lines = renderListRow({
      label: "Item",
      description: longDesc,
      width: 60,
    });
    expect(lines.length).toBeGreaterThan(1);
    // 续行：左区为 30 个空格
    expect(stripAnsi(lines[1]!).slice(0, 30)).toBe(" ".repeat(30));
  });
});
