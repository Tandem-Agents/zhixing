import { describe, expect, it } from "vitest";
import { renderFooter } from "../footer.js";
import { stripAnsi } from "../ansi.js";

describe("renderFooter", () => {
  it("返回两行：分隔 + 提示", () => {
    const lines = renderFooter({ width: 40, hints: ["A", "B"] });
    expect(lines).toHaveLength(2);
  });

  it("分隔行宽度等于 width", () => {
    const [sep] = renderFooter({ width: 50, hints: ["x"] });
    expect(stripAnsi(sep!)).toHaveLength(50);
  });

  it("提示行用中点分隔", () => {
    const [, hint] = renderFooter({
      width: 40,
      hints: ["↑↓ 选择", "Enter 进入", "Ctrl+C 退出"],
    });
    expect(stripAnsi(hint!)).toContain("↑↓ 选择");
    expect(stripAnsi(hint!)).toContain("·");
    expect(stripAnsi(hint!)).toContain("Ctrl+C 退出");
  });
});
