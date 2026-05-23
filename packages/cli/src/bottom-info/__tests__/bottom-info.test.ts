/**
 * bottom-info 单元测试 —— 来源无关容器 + 双区布局纯函数。
 */

import { describe, expect, it } from "vitest";

import { stripAnsi } from "../../tui/ansi.js";
import { stringWidth } from "../../tui/line-width.js";
import {
  BottomInfoModel,
  BOTTOM_INFO_IDS,
  renderBottomInfoLine,
} from "../index.js";

describe("BottomInfoModel", () => {
  it("set 后 snapshot 按区返回内容", () => {
    const m = new BottomInfoModel();
    m.set("right", BOTTOM_INFO_IDS.escHint, "esc 清空");
    expect(m.snapshot()).toEqual({ left: [], right: ["esc 清空"] });
  });

  it("set(null) 清除块", () => {
    const m = new BottomInfoModel();
    m.set("right", BOTTOM_INFO_IDS.escHint, "esc 清空");
    m.set("right", BOTTOM_INFO_IDS.escHint, null);
    expect(m.snapshot()).toEqual({ left: [], right: [] });
  });

  it("同 id 覆盖更新", () => {
    const m = new BottomInfoModel();
    m.set("right", BOTTOM_INFO_IDS.escHint, "a");
    m.set("right", BOTTOM_INFO_IDS.escHint, "b");
    expect(m.snapshot().right).toEqual(["b"]);
  });

  it("初始 snapshot 两区皆空", () => {
    expect(new BottomInfoModel().snapshot()).toEqual({ left: [], right: [] });
  });
});

describe("renderBottomInfoLine", () => {
  it("左右皆空 → 整行 width 空格(占位)", () => {
    expect(renderBottomInfoLine([], [], 10)).toBe(" ".repeat(10));
  });

  it("仅右区 → 右对齐,可见宽度 = width", () => {
    const line = renderBottomInfoLine([], ["abc"], 10);
    expect(line).toBe(" ".repeat(7) + "abc");
    expect(stringWidth(line)).toBe(10);
  });

  it("左右各一块 → 左对齐 + 右对齐 + 中间填充", () => {
    expect(renderBottomInfoLine(["L"], ["R"], 10)).toBe(
      "L" + " ".repeat(8) + "R",
    );
  });

  it("CJK 块按显示宽度右对齐(可见宽度 = width)", () => {
    // "清空" 占 4 列
    const line = renderBottomInfoLine([], ["清空"], 10);
    expect(stringWidth(line)).toBe(10);
    expect(line.endsWith("清空")).toBe(true);
  });

  it("超宽 → 右区优先保留、左区截断,可见宽度不超 width", () => {
    const line = renderBottomInfoLine(
      ["很长很长很长很长的左侧文字"],
      ["右"],
      8,
    );
    expect(stringWidth(stripAnsi(line))).toBeLessThanOrEqual(8);
    // 右区(优先)仍在
    expect(stripAnsi(line).endsWith("右")).toBe(true);
  });

  it("width <= 0 → 空串(防御)", () => {
    expect(renderBottomInfoLine([], ["x"], 0)).toBe("");
  });
});
