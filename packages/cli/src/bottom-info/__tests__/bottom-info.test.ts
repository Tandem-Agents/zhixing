/**
 * bottom-info 单元测试 —— 来源无关容器 + 双区布局纯函数。
 */

import { describe, expect, it, vi } from "vitest";

import { stripAnsi } from "../../tui/ansi.js";
import { stringWidth } from "../../tui/line-width.js";
import {
  BottomInfoModel,
  renderBottomInfoLine,
} from "../index.js";

describe("BottomInfoModel", () => {
  it("set 后 snapshot 按区返回内容", () => {
    const m = new BottomInfoModel();
    const source = m.createSource();
    source.set("right", "keys", "esc 清空");
    expect(m.snapshot()).toEqual({ left: [], right: ["esc 清空"] });
  });

  it("set(null) 清除块", () => {
    const m = new BottomInfoModel();
    const source = m.createSource();
    source.set("right", "keys", "esc 清空");
    source.set("right", "keys", null);
    expect(m.snapshot()).toEqual({ left: [], right: [] });
  });

  it("同 id 覆盖更新", () => {
    const m = new BottomInfoModel();
    const source = m.createSource();
    source.set("right", "keys", "a");
    source.set("right", "keys", "b");
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

  it("窄窗口截断仍分隔说明和操作，不能把左右文字粘成一句", () => {
    const line = stripAnsi(renderBottomInfoLine(["场景名称"], ["Enter 提交"], 15));
    expect(line).toMatch(/  Enter 提交$/u);
    expect(stringWidth(line)).toBeLessThanOrEqual(15);
    expect(renderBottomInfoLine(["说明"], ["Enter"], 6)).toBe(" Enter");
  });
});


describe("发布所有权与场景有效期", () => {
  it("相同块名的不同来源互不覆盖；只撤销自己的内容", () => {
    const model = new BottomInfoModel();
    const a = model.createSource(), b = model.createSource();
    b.set("left", "notice", "B");
    a.set("left", "notice", "A");
    a.set("right", "keys", "R");
    expect(model.snapshot()).toEqual({ left: ["A", "B"], right: ["R"] });
    a.dispose();
    a.set("left", "notice", "迟到");
    expect(model.snapshot()).toEqual({ left: ["B"], right: [] });
  });

  it("跨场景公告共享，局部公告隔离；暂停、恢复和结束遵循有效期", () => {
    const model = new BottomInfoModel();
    const global = model.createSource(), a = model.createScope(), b = model.createScope();
    const scoped = a.createSource();
    global.set("left", "notice", "共享");
    scoped.set("right", "notice", "局部");
    expect(model.snapshot(a)).toEqual({ left: ["共享"], right: ["局部"] });
    expect(model.snapshot(b).right).toEqual([]);
    a.pause();
    expect(model.snapshot(a).right).toEqual([]);
    scoped.set("right", "notice", "最新");
    a.resume();
    expect(model.snapshot(a).right).toEqual(["最新"]);
    a.dispose();
    scoped.set("left", "notice", "失效");
    a.createSource().set("left", "new", "无效");
    a.resume();
    expect(a.visible).toBe(false);
    expect(model.snapshot(a)).toEqual({ left: ["共享"], right: [] });
  });

  it("只通知有效变化与适用场景；停止订阅、结束场景后不再回调", () => {
    const model = new BottomInfoModel();
    const a = model.createScope(), b = model.createScope();
    const source = a.createSource(), global = model.createSource();
    const ca = vi.fn(), cb = vi.fn();
    const unsubscribe = a.subscribe(ca);
    b.subscribe(cb);
    source.set("left", "x", null);
    source.set("left", "x", "one");
    source.set("left", "x", "one");
    expect(ca).toHaveBeenCalledTimes(1);
    expect(cb).not.toHaveBeenCalled();
    source.set("left", "x", null);
    global.set("right", "x", "two");
    expect(ca).toHaveBeenCalledTimes(3);
    expect(cb).toHaveBeenCalledTimes(1);
    unsubscribe();
    b.dispose();
    global.dispose();
    expect(ca).toHaveBeenCalledTimes(3);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
