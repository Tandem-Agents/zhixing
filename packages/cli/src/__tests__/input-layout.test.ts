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

describe("layoutInputBuffer — atomicRegions 不切碎", () => {
  const ATOM = /\[ATOM\]/g; // 6 chars

  it("atomic 整体放不下当前行时整体换行", () => {
    // contentBudget=10, prompt 2 → lineWidth=8
    // 'a','b','c','d'(4) + atomic 6 = 10 > 8 → atomic 整体换行
    const r = layoutInputBuffer(PROMPT, "abcd[ATOM]", 0, "", 10, ATOM);
    expect(r.bodyLines).toHaveLength(2);
    expect(r.bodyLines[0]).toBe(`${PROMPT}abcd`);
    expect(r.bodyLines[1]).toBe("  [ATOM]");
  });

  it("atomic 完整放当前行时不换行", () => {
    const r = layoutInputBuffer(PROMPT, "ab[ATOM]", 0, "", 10, ATOM);
    // 2+6=8 = lineWidth 刚好放下
    expect(r.bodyLines).toHaveLength(1);
    expect(r.bodyLines[0]).toBe(`${PROMPT}ab[ATOM]`);
  });

  it("不传 atomicRegions 时 atomic 被字符级 wrap 切碎（向后兼容）", () => {
    const r = layoutInputBuffer(PROMPT, "abcd[ATOM]", 0, "", 10);
    expect(r.bodyLines).toHaveLength(2);
    expect(r.bodyLines[0]).toBe(`${PROMPT}abcd[ATO`);
    expect(r.bodyLines[1]).toBe("  M]");
  });

  it("atomic 之前的内容仍可被字符级 wrap", () => {
    // lineWidth=8, draft = "abcdefghi[ATOM]"
    // 'a'..'h'(8) → wrap → 'i' new line, +atomic 1+6=7 ≤ 8 ok
    const r = layoutInputBuffer(PROMPT, "abcdefghi[ATOM]", 0, "", 10, ATOM);
    expect(r.bodyLines).toHaveLength(2);
    expect(r.bodyLines[0]).toBe(`${PROMPT}abcdefgh`);
    expect(r.bodyLines[1]).toBe("  i[ATOM]");
  });

  it("多个 atomic 区域分别整体处理", () => {
    // lineWidth=8, [ATOM][ATOM] = 12 chars → 第二个 atomic 整体换行
    const r = layoutInputBuffer(PROMPT, "[ATOM][ATOM]", 0, "", 10, ATOM);
    expect(r.bodyLines).toHaveLength(2);
    expect(r.bodyLines[0]).toBe(`${PROMPT}[ATOM]`);
    expect(r.bodyLines[1]).toBe("  [ATOM]");
  });

  it("支持多类 atomic pattern 共用同一布局契约", () => {
    const ONE = /\[ONE\]/g;
    const TWO = /\[TWO\]/g;
    const r = layoutInputBuffer(
      PROMPT,
      "abcd[ONE]def[TWO]",
      0,
      "",
      10,
      [ONE, TWO],
    );
    expect(r.bodyLines).toEqual([
      `${PROMPT}abcd`,
      "  [ONE]def",
      "  [TWO]",
    ]);
  });
});

describe("layoutInputBuffer — \\n 硬换行", () => {
  it("\\n 触发硬换行，续行用 hangingIndent", () => {
    const r = layoutInputBuffer(PROMPT, "line1\nline2", 0, "", 80);
    expect(r.bodyLines).toHaveLength(2);
    expect(r.bodyLines[0]).toBe(`${PROMPT}line1`);
    expect(r.bodyLines[1]).toBe("  line2");
  });

  it("多个 \\n 多次硬换行", () => {
    const r = layoutInputBuffer(PROMPT, "a\nb\nc", 0, "", 80);
    expect(r.bodyLines).toHaveLength(3);
    expect(r.bodyLines[0]).toBe(`${PROMPT}a`);
    expect(r.bodyLines[1]).toBe("  b");
    expect(r.bodyLines[2]).toBe("  c");
  });

  it("末尾 \\n 产生空续行（hangingIndent 之后无内容）", () => {
    const r = layoutInputBuffer(PROMPT, "a\n", 0, "", 80);
    expect(r.bodyLines).toHaveLength(2);
    expect(r.bodyLines[0]).toBe(`${PROMPT}a`);
    expect(r.bodyLines[1]).toBe("  ");
  });

  it("cursor 在 \\n 之前落上一行末", () => {
    // draft="a\nb" cursor=1 在 \n 之前 = 'a' 之后
    const r = layoutInputBuffer(PROMPT, "a\nb", 1, "", 80);
    expect(r.cursorRow).toBe(0);
    expect(r.cursorCol).toBe(2 + 1);
  });

  it("cursor 在 \\n 之后落新行 col=0（hangingIndent 之后）", () => {
    // draft="a\nb" cursor=2 在 \n 之后 = 'b' 之前
    const r = layoutInputBuffer(PROMPT, "a\nb", 2, "", 80);
    expect(r.cursorRow).toBe(1);
    expect(r.cursorCol).toBe(2);
  });

  it("cursor 在末行的字符之后", () => {
    const r = layoutInputBuffer(PROMPT, "ab\ncd", 5, "", 80);
    expect(r.cursorRow).toBe(1);
    expect(r.cursorCol).toBe(2 + 2);
  });

  it("\\n 段间续行也应用软 wrap", () => {
    // lineWidth=4, draft = "ab\ncdef"
    // 行0: "ab"
    // 行1: "cdef" (4 chars, 刚满 lineWidth=4)
    const r = layoutInputBuffer(PROMPT, "ab\ncdef", 0, "", 6);
    expect(r.bodyLines).toHaveLength(2);
    expect(r.bodyLines[0]).toBe(`${PROMPT}ab`);
    expect(r.bodyLines[1]).toBe("  cdef");
  });
});

describe("layoutInputBuffer — atomic + \\n 混合", () => {
  const ATOM = /\[ATOM\]/g;

  it("\\n 段间 atomic 整体处理", () => {
    const r = layoutInputBuffer(PROMPT, "x\n[ATOM]y", 0, "", 80, ATOM);
    expect(r.bodyLines).toHaveLength(2);
    expect(r.bodyLines[0]).toBe(`${PROMPT}x`);
    expect(r.bodyLines[1]).toBe("  [ATOM]y");
  });

  it("atomic 之后的 \\n 继续硬换行", () => {
    const r = layoutInputBuffer(PROMPT, "[ATOM]\nx", 0, "", 80, ATOM);
    expect(r.bodyLines).toHaveLength(2);
    expect(r.bodyLines[0]).toBe(`${PROMPT}[ATOM]`);
    expect(r.bodyLines[1]).toBe("  x");
  });

  it("cursor 在 atomic 起始落 atomic 之前", () => {
    // draft="a[ATOM]b" cursor=1 在 '[' 之前
    const r = layoutInputBuffer(PROMPT, "a[ATOM]b", 1, "", 80, ATOM);
    expect(r.cursorRow).toBe(0);
    expect(r.cursorCol).toBe(2 + 1); // prompt + 'a'
  });

  it("cursor 在 atomic 内部落 atomic 末尾（简化版语义）", () => {
    // draft="a[ATOM]b" cursor=3 (在 'A' 之后，atomic 内部)
    const r = layoutInputBuffer(PROMPT, "a[ATOM]b", 3, "", 80, ATOM);
    expect(r.cursorRow).toBe(0);
    expect(r.cursorCol).toBe(2 + 1 + 6); // prompt + 'a' + [ATOM]
  });

  it("cursor 在 atomic 末尾", () => {
    // draft="a[ATOM]b" cursor=7 在 ']' 之后
    const r = layoutInputBuffer(PROMPT, "a[ATOM]b", 7, "", 80, ATOM);
    expect(r.cursorRow).toBe(0);
    expect(r.cursorCol).toBe(2 + 1 + 6); // prompt + 'a' + [ATOM]
  });
});

describe("layoutInputBuffer — paintVisualCursor（chrome 模式视觉光标）", () => {
  // chrome 模式下硬件光标永久隐藏，输入光标由 layout 在 cursorRow 上画 reverse
  // SGR 承担。下列测试覆盖核心边界。视觉宽度不变量：cursor 内嵌路径输出可见
  // 宽度 = 输入 text 可见宽度（不偏移）；末位 cursor 路径 +1（反白空格）。

  const REVERSE_ON = "\x1b[7m";
  const REVERSE_OFF = "\x1b[27m";

  it("默认不画视觉光标——bodyLines 与原行为一致（向后兼容）", () => {
    const r = layoutInputBuffer(PROMPT, "hello", 2, "", 80);
    expect(r.bodyLines).toEqual([`${PROMPT}hello`]);
    // 显式 false 与省略等价
    const r2 = layoutInputBuffer(PROMPT, "hello", 2, "", 80, undefined, false);
    expect(r2.bodyLines).toEqual([`${PROMPT}hello`]);
  });

  it("cursor 在文本中间——包裹该字符（视觉宽度不变）", () => {
    const r = layoutInputBuffer(PROMPT, "hello", 2, "", 80, undefined, true);
    // text="hello", cursorDraftCol=2 → 包裹 'l'（第二个 l）
    expect(r.bodyLines).toEqual([
      `${PROMPT}he${REVERSE_ON}l${REVERSE_OFF}lo`,
    ]);
    // stripAnsi 后视觉宽度不变
    expect(stripAnsi(r.bodyLines[0]!)).toBe(`${PROMPT}hello`);
  });

  it("cursor 在文本开头——包裹首字符", () => {
    const r = layoutInputBuffer(PROMPT, "hello", 0, "", 80, undefined, true);
    expect(r.bodyLines).toEqual([
      `${PROMPT}${REVERSE_ON}h${REVERSE_OFF}ello`,
    ]);
  });

  it("cursor 在文本末尾——末位追加反白空格（可见宽度 +1）", () => {
    const r = layoutInputBuffer(PROMPT, "hello", 5, "", 80, undefined, true);
    expect(r.bodyLines).toEqual([
      `${PROMPT}hello${REVERSE_ON} ${REVERSE_OFF}`,
    ]);
  });

  it("空 draft + cursor=0——仅一个反白空格（输入框起始位置可见光标）", () => {
    const r = layoutInputBuffer(PROMPT, "", 0, "", 80, undefined, true);
    expect(r.bodyLines).toEqual([`${PROMPT}${REVERSE_ON} ${REVERSE_OFF}`]);
  });

  it("CJK 全角字符上的 cursor——整字符包裹，宽度不变", () => {
    const r = layoutInputBuffer(PROMPT, "你好", 0, "", 80, undefined, true);
    // cursor=0 → 包裹 '你'（全角宽 2）
    expect(r.bodyLines).toEqual([
      `${PROMPT}${REVERSE_ON}你${REVERSE_OFF}好`,
    ]);
    expect(stripAnsi(r.bodyLines[0]!)).toBe(`${PROMPT}你好`);
  });

  it("CJK 之后位置的 cursor——按可见列累计正确定位到下一字符", () => {
    const r = layoutInputBuffer(PROMPT, "你好", 1, "", 80, undefined, true);
    // cursor=1 → cursorDraftCol=2（'你'占 2 列）→ 包裹 '好'
    expect(r.bodyLines).toEqual([
      `${PROMPT}你${REVERSE_ON}好${REVERSE_OFF}`,
    ]);
  });

  it("wrap 多行——仅 cursorRow 行画视觉光标", () => {
    // contentBudget=10, prompt=2 → lineWidth=8；draft 10 字符 → wrap 8+2
    const r = layoutInputBuffer(
      PROMPT,
      "abcdefghij",
      9, // cursor=9 在 'j' 之上（chars[9]='j'，续行内 draftCol=1）
      "",
      10,
      undefined,
      true,
    );
    expect(r.bodyLines).toHaveLength(2);
    // 首行：text="abcdefgh"，不是 cursorRow → 不画
    expect(r.bodyLines[0]).toBe(`${PROMPT}abcdefgh`);
    // 续行：cursorRow，text="ij"，cursor=9 → cursor 在 'j' 上 → 包裹 'j'
    expect(r.bodyLines[1]).toBe(`  i${REVERSE_ON}j${REVERSE_OFF}`);
  });

  it("wrap 多行 + cursor 在末尾——续行末位追加反白空格", () => {
    const r = layoutInputBuffer(
      PROMPT,
      "abcdefghij",
      10, // cursor 在所有字符之后
      "",
      10,
      undefined,
      true,
    );
    expect(r.bodyLines).toHaveLength(2);
    expect(r.bodyLines[0]).toBe(`${PROMPT}abcdefgh`);
    expect(r.bodyLines[1]).toBe(`  ij${REVERSE_ON} ${REVERSE_OFF}`);
  });

  it("有 suffix（placeholder / ghost）+ cursor 在末尾——反白空格插入 text 与 suffix 之间", () => {
    const suffix = `\x1b[2mghost\x1b[0m`; // dim ghost text
    const r = layoutInputBuffer(
      PROMPT,
      "hello",
      5, // cursor 在 'o' 之后
      suffix,
      80,
      undefined,
      true,
    );
    // text 后插反白空格再拼 suffix
    expect(r.bodyLines).toEqual([
      `${PROMPT}hello${REVERSE_ON} ${REVERSE_OFF}${suffix}`,
    ]);
  });

  it("paint 不影响 cursorRow / cursorCol 元数据", () => {
    const r1 = layoutInputBuffer(PROMPT, "hello", 3, "", 80, undefined, false);
    const r2 = layoutInputBuffer(PROMPT, "hello", 3, "", 80, undefined, true);
    expect(r2.cursorRow).toBe(r1.cursorRow);
    expect(r2.cursorCol).toBe(r1.cursorCol);
  });
});
