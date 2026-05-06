import { describe, expect, it } from "vitest";
import chalk from "chalk";
import { layoutInputBuffer } from "../input-layout.js";
import { stripAnsi, stringWidth } from "../tui/index.js";

chalk.level = 3;

const PROMPT = "❯ "; // 可见宽 2（"❯" 是 East Asian Neutral = 1 列，加空格 1 列）

describe("layoutInputBuffer — 单行不 wrap", () => {
  it("空 draft 返回单行（仅 prompt）+ cursor 在 prompt 之后", () => {
    const r = layoutInputBuffer(PROMPT, "", 0, "", 80);
    expect(r.bodyLines).toEqual([PROMPT]);
    expect(r.cursorRow).toBe(0);
    expect(r.cursorCol).toBe(2); // promptVisibleWidth
  });

  it("短文本不 wrap——单行 prompt + draft", () => {
    const r = layoutInputBuffer(PROMPT, "hello", 5, "", 80);
    expect(r.bodyLines).toEqual([`${PROMPT}hello`]);
    expect(r.cursorRow).toBe(0);
    expect(r.cursorCol).toBe(2 + 5); // prompt + "hello".length
  });

  it("cursor 在 draft 中间位置", () => {
    const r = layoutInputBuffer(PROMPT, "abcdef", 3, "", 80);
    expect(r.cursorRow).toBe(0);
    expect(r.cursorCol).toBe(2 + 3); // prompt + "abc"
  });

  it("CJK 全角字符按 2 列计算", () => {
    const r = layoutInputBuffer(PROMPT, "你好", 1, "", 80);
    // cursor 在"你"之后，"你"宽 2
    expect(r.cursorRow).toBe(0);
    expect(r.cursorCol).toBe(2 + 2);
  });
});

describe("layoutInputBuffer — wrap 多行", () => {
  it("draft 超过 lineWidth 被 wrap 成两行（第二行 hanging indent 与 prompt 同宽）", () => {
    // contentBudget=10, prompt 占 2 → lineWidth=8
    const r = layoutInputBuffer(PROMPT, "abcdefghij", 0, "", 10);
    expect(r.bodyLines).toHaveLength(2);
    // 首行 = "❯ " + 8 chars（"abcdefgh"）
    expect(r.bodyLines[0]).toBe(`${PROMPT}abcdefgh`);
    // 续行 = 2 空格 hanging + 余下 chars
    expect(r.bodyLines[1]).toBe("  ij");
  });

  it("续行 hanging indent 可见宽 = promptVisibleWidth", () => {
    const r = layoutInputBuffer(PROMPT, "a".repeat(20), 0, "", 12);
    // lineWidth = 12 - 2 = 10
    expect(r.bodyLines).toHaveLength(2);
    expect(r.bodyLines[0]).toBe(`${PROMPT}${"a".repeat(10)}`);
    expect(r.bodyLines[1]).toBe(`  ${"a".repeat(10)}`);
    // 两行可见宽相同
    expect(stringWidth(r.bodyLines[0]!)).toBe(stringWidth(r.bodyLines[1]!));
  });

  it("CJK 内容 wrap：宽度按可视列累计、不打断字符", () => {
    // contentBudget=8, prompt=2 → lineWidth=6（每行最多 3 个 CJK）
    const r = layoutInputBuffer(PROMPT, "中文换行测试", 0, "", 8);
    // "中文换" wraps then "行测试"
    expect(r.bodyLines).toHaveLength(2);
    expect(r.bodyLines[0]).toBe(`${PROMPT}中文换`);
    expect(r.bodyLines[1]).toBe("  行测试");
  });

  it("多次 wrap 成三行", () => {
    // lineWidth=4，30 个 a 应该 wrap 8 次（4+4+4+...）
    const r = layoutInputBuffer(PROMPT, "a".repeat(30), 0, "", 6);
    expect(r.bodyLines.length).toBeGreaterThanOrEqual(8);
  });
});

describe("layoutInputBuffer — cursor 跨行定位", () => {
  it("cursor 在第二行某位置——row=1, col 含 hanging 偏移", () => {
    // lineWidth=8, draft 12 chars: 行 0 = chars[0..7], 行 1 = chars[8..11]
    // cursor=10 → 落在行 1 的 chars[10] 之后 = chars[10..11] 含 'k'
    const r = layoutInputBuffer(PROMPT, "abcdefghijkl", 10, "", 10);
    expect(r.bodyLines).toHaveLength(2);
    expect(r.cursorRow).toBe(1);
    // col = promptVisibleWidth(2) + draftCol(2) = 4
    // (chars[8]='i' chars[9]='j' 之后 cursor=10，行内 col 走过 'i','j' 各 1 列)
    expect(r.cursorCol).toBe(2 + 2);
  });

  it("cursor 在 wrap 边界——上一行字符刚好填满后，cursor 仍在上一行末", () => {
    // lineWidth=4, draft="abcd" + "ef" = 6 chars
    // 行 0 = "abcd"(width 4), 行 1 = "ef"
    // cursor=4 → 在 'd' 之后即行 0 末
    const r = layoutInputBuffer(PROMPT, "abcdef", 4, "", 6);
    expect(r.cursorRow).toBe(0);
    expect(r.cursorCol).toBe(2 + 4); // prompt + 4
  });

  it("cursor=draft.length（末位）正确落到末行末", () => {
    const r = layoutInputBuffer(PROMPT, "hello", 5, "", 80);
    expect(r.cursorRow).toBe(0);
    expect(r.cursorCol).toBe(2 + 5);
  });

  it("cursor=0（首位）落到首行 prompt 之后", () => {
    const r = layoutInputBuffer(PROMPT, "abc", 0, "", 80);
    expect(r.cursorRow).toBe(0);
    expect(r.cursorCol).toBe(2);
  });

  it("cursor 越界（> draft.length）落到末行末（防御性）", () => {
    const r = layoutInputBuffer(PROMPT, "abc", 100, "", 80);
    expect(r.cursorRow).toBe(0);
    expect(r.cursorCol).toBe(2 + 3);
  });
});

describe("layoutInputBuffer — suffix 拼接", () => {
  it("suffix 拼到末行末（不参与 wrap）", () => {
    const r = layoutInputBuffer(PROMPT, "hi", 2, " · 提示", 80);
    expect(r.bodyLines[0]).toBe(`${PROMPT}hi · 提示`);
  });

  it("多行时 suffix 只拼到最后一行", () => {
    const r = layoutInputBuffer(
      PROMPT,
      "abcdefghij",
      0,
      " ← ghost",
      10, // lineWidth=8
    );
    expect(r.bodyLines).toHaveLength(2);
    expect(r.bodyLines[0]).toBe(`${PROMPT}abcdefgh`);
    expect(r.bodyLines[1]).toBe("  ij ← ghost");
  });

  it("suffix 不影响 cursor 定位", () => {
    const r = layoutInputBuffer(PROMPT, "ab", 1, " · ghost", 80);
    expect(r.cursorRow).toBe(0);
    expect(r.cursorCol).toBe(2 + 1); // 仅根据 draft 计算
  });

  it("空 draft + suffix（placeholder 场景）", () => {
    const r = layoutInputBuffer(PROMPT, "", 0, " 输入消息或 / 查看命令", 80);
    expect(r.bodyLines[0]).toBe(`${PROMPT} 输入消息或 / 查看命令`);
    expect(r.cursorRow).toBe(0);
    expect(r.cursorCol).toBe(2);
  });
});

describe("layoutInputBuffer — ANSI 颜色处理", () => {
  it("promptPrefix 含 ANSI 颜色——可见宽度按 stripAnsi 算", () => {
    const colored = "\x1b[36m\x1b[1m❯\x1b[22m\x1b[39m ";
    const r = layoutInputBuffer(colored, "hello", 5, "", 80);
    // 可见宽仍是 2（❯ + space）
    expect(r.cursorCol).toBe(2 + 5);
    expect(stripAnsi(r.bodyLines[0]!)).toBe("❯ hello");
  });

  it("续行 hanging 不含 ANSI（纯空格）", () => {
    const colored = "\x1b[36m\x1b[1m❯\x1b[22m\x1b[39m ";
    const r = layoutInputBuffer(colored, "a".repeat(20), 0, "", 12);
    expect(r.bodyLines[1]).toBe(`  ${"a".repeat(10)}`);
    expect(r.bodyLines[1]).not.toContain("\x1b");
  });
});

describe("layoutInputBuffer — 极端边界", () => {
  it("contentBudget 比 prompt 还小——lineWidth 兜底为 1", () => {
    const r = layoutInputBuffer(PROMPT, "abc", 0, "", 1);
    // lineWidth 退化为 1 也能 wrap 不挂
    expect(r.bodyLines.length).toBeGreaterThanOrEqual(1);
  });

  it("超长单字符（如代理对/emoji）——按字符边界切分", () => {
    const r = layoutInputBuffer(PROMPT, "你好世界", 4, "", 6);
    // lineWidth=4，每行 2 个 CJK
    expect(r.bodyLines).toHaveLength(2);
    expect(r.bodyLines[0]).toBe(`${PROMPT}你好`);
    expect(r.bodyLines[1]).toBe("  世界");
    // cursor=4 在末位
    expect(r.cursorRow).toBe(1);
  });
});
