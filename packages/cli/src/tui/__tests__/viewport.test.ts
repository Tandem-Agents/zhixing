import { describe, it, expect } from "vitest";
import { composeViewport } from "../viewport.js";

describe("composeViewport", () => {
  it("内容放得下:中间补空行把底部顶到最下沿,总行数 = height", () => {
    const out = composeViewport({
      height: 10,
      top: ["T"],
      scroll: ["a", "b"],
      bottom: ["B1", "B2"],
    });
    expect(out).toHaveLength(10);
    expect(out[0]).toBe("T"); // 顶固定
    expect(out[1]).toBe("a");
    expect(out[2]).toBe("b");
    expect(out[3]).toBe(""); // 填充空行
    expect(out.slice(-2)).toEqual(["B1", "B2"]); // 底固定、顶到最下沿
  });

  it("内容超出:顶部对齐截断 + 末行折叠提示,总行数 = height", () => {
    const out = composeViewport({
      height: 6,
      top: ["T"],
      scroll: ["1", "2", "3", "4", "5"],
      bottom: ["B"],
      overflowHint: "⋯more",
    });
    // avail = 6 - 1 - 1 = 4;截断 slice(0,3) + 提示
    expect(out).toEqual(["T", "1", "2", "3", "⋯more", "B"]);
  });

  it("超出但无 overflowHint:纯截断到 avail", () => {
    const out = composeViewport({
      height: 5,
      top: ["T"],
      scroll: ["1", "2", "3", "4", "5"],
      bottom: ["B"],
    });
    // avail = 3
    expect(out).toEqual(["T", "1", "2", "3", "B"]);
  });

  it("底部固定区永远在(内容再多也不挤掉 bottom)", () => {
    const out = composeViewport({
      height: 4,
      top: [],
      scroll: ["1", "2", "3", "4", "5", "6"],
      bottom: ["INPUT"],
      overflowHint: "⋯",
    });
    expect(out).toHaveLength(4);
    expect(out[out.length - 1]).toBe("INPUT"); // 底部锚点保住
  });

  it("极矮终端(顶/底撑满):优先保底部,中间不显示", () => {
    const out = composeViewport({
      height: 2,
      top: ["T1", "T2"],
      scroll: ["x"],
      bottom: ["B1", "B2"],
    });
    expect(out).toEqual(["T1", "T2", "B1", "B2"]); // avail <= 0
  });

  it("空 bottom(如 external 提示页)也成立", () => {
    const out = composeViewport({
      height: 5,
      top: ["T"],
      scroll: ["a"],
      bottom: [],
    });
    expect(out).toHaveLength(5);
    expect(out).toEqual(["T", "a", "", "", ""]);
  });
});
