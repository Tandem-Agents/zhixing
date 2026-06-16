/**
 * farewell 单测 —— 验证 renderFarewell 的字节布局契约。
 *
 * 测试边界：纯函数，输入 FarewellData → 输出字符串，无副作用。
 * 断言 strip ANSI 后的可见文本结构，不锁定具体 ANSI 颜色码（让未来调色不破坏测试）。
 */

import { describe, expect, it } from "vitest";
import {
  BRAND_ANCHOR_GLYPH_ROW1,
  BRAND_ANCHOR_GLYPH_ROW2,
  BRAND_ANCHOR_GLYPH_ROW3,
  BRAND_ANCHOR_TOP_EDGE,
} from "../../tui/index.js";
import { renderFarewell } from "../farewell.js";

/** 去除 ANSI 颜色码（CSI sequences），保留可见字符 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("renderFarewell · 字节布局", () => {
  it("返回 6 行（首空行 + 天线 + 头 + 脸 + 下巴 + 末空行）+ 末尾换行", () => {
    const out = renderFarewell({ conversationId: "chat-test-xyz" });
    const plain = stripAnsi(out);
    const lines = plain.split("\n");
    // split 后末尾换行产生一个空字符串元素，所以应有 7 个元素（6 行内容 + 1 空尾）
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe(""); // 首空行
    expect(lines[5]).toBe(""); // 末空行
    expect(lines[6]).toBe(""); // 末尾换行后的空字符串
  });

  it("行 2 含天线字符", () => {
    const plain = stripAnsi(renderFarewell({ conversationId: "x" }));
    expect(plain.split("\n")[1]).toContain(BRAND_ANCHOR_TOP_EDGE);
  });

  it("行 3 含机器人头顶 ROW1", () => {
    const plain = stripAnsi(renderFarewell({ conversationId: "x" }));
    expect(plain.split("\n")[2]).toContain(BRAND_ANCHOR_GLYPH_ROW1.trim());
  });

  it("行 4 含机器人脸 ROW2 + '知行' 标识", () => {
    const plain = stripAnsi(renderFarewell({ conversationId: "x" }));
    const row = plain.split("\n")[3]!;
    expect(row).toContain(BRAND_ANCHOR_GLYPH_ROW2);
    expect(row).toContain("知行");
  });

  it("行 5 含机器人下巴 ROW3 + conversationId", () => {
    const plain = stripAnsi(
      renderFarewell({ conversationId: "chat-20260512-6bce" }),
    );
    const row = plain.split("\n")[4]!;
    expect(row).toContain(BRAND_ANCHOR_GLYPH_ROW3.trim());
    expect(row).toContain("chat-20260512-6bce");
  });

  it("机器人脸右侧标识 / 对话 ID 起始列对齐（同 inline gap）", () => {
    const plain = stripAnsi(renderFarewell({ conversationId: "abc" }));
    const lines = plain.split("\n");
    const brandCol = lines[3]!.indexOf("知行");
    const convIdCol = lines[4]!.indexOf("abc");
    expect(brandCol).toBe(convIdCol);
    expect(brandCol).toBeGreaterThan(0); // 不应在行首
  });

  it("不同 conversationId 输出不同末段，其他部分稳定", () => {
    const a = stripAnsi(renderFarewell({ conversationId: "id-A" }));
    const b = stripAnsi(renderFarewell({ conversationId: "id-B" }));
    expect(a).not.toBe(b);
    // 前 4 行（首空 + 天线 + 头 + 脸）应相同
    const headerA = a.split("\n").slice(0, 4).join("\n");
    const headerB = b.split("\n").slice(0, 4).join("\n");
    expect(headerA).toBe(headerB);
  });

  it("可把普通退出提示放进告别块，确保 Ctrl+C 等路径退出后仍可见", () => {
    const plain = stripAnsi(
      renderFarewell({
        conversationId: "chat-test",
        exitHint: "已退出当前终端；知行仍在飞书中运行。",
      }),
    );

    expect(plain).toContain("chat-test");
    expect(plain).toContain("已退出当前终端；知行仍在飞书中运行。");
  });

  // ANSI 着色由 chalk 在 TTY 环境自动启用 —— 单测环境 chalk 检测到 non-TTY 时
  // 关闭颜色码，所以不在此断言"必含 ANSI 序列"（与 chalk 设计意图一致）。
});
