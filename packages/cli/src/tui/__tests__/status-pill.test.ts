import { describe, expect, it } from "vitest";
import { renderStatusPill } from "../status-pill.js";
import { stripAnsi } from "../ansi.js";

describe("renderStatusPill", () => {
  it("ready 拼出 ✓ + 文本", () => {
    expect(stripAnsi(renderStatusPill("ready", "已配齐"))).toBe("✓ 已配齐");
  });

  it("pending 拼出 ⚠ + 文本", () => {
    expect(stripAnsi(renderStatusPill("pending", "待补 API Key"))).toBe(
      "⚠ 待补 API Key",
    );
  });

  it("disabled 拼出 · + 文本", () => {
    expect(stripAnsi(renderStatusPill("disabled", "未启用"))).toBe("· 未启用");
  });
});
