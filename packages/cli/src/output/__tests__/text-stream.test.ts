import { describe, expect, it } from "vitest";
import { TextStream } from "../text-stream.js";
import { ANCHOR_AI_DONE } from "../speaker-state.js";
import { stripAnsi } from "../../tui/ansi.js";

interface Capture {
  buffer: string;
}

function makeStream(cols = 80): { stream: TextStream; out: Capture } {
  const out: Capture = { buffer: "" };
  const stream = new TextStream({
    write: (chunk) => {
      out.buffer += chunk;
    },
    columns: cols,
  });
  return { stream, out };
}

describe("TextStream 起首", () => {
  it("第一次 feed 自动插入 `  ◆ ` 锚 + 1 空格", () => {
    const { stream, out } = makeStream();
    stream.feed("hello");
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} hello`);
  });

  it("空 chunk 不触发起首", () => {
    const { stream, out } = makeStream();
    stream.feed("");
    expect(out.buffer).toBe("");
  });

  it("流式多次 feed 锚只插一次", () => {
    const { stream, out } = makeStream();
    stream.feed("hello ");
    stream.feed("world");
    const anchorMatches = out.buffer.match(/◆/g) ?? [];
    expect(anchorMatches.length).toBe(1);
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} hello world`);
  });
});

describe("TextStream 硬换行", () => {
  it("\\n 触发硬换行 + hanging 4 缩进", () => {
    const { stream, out } = makeStream();
    stream.feed("line1\nline2");
    expect(stripAnsi(out.buffer)).toBe(
      `  ${ANCHOR_AI_DONE} line1\n    line2`,
    );
  });

  it("连续多个 \\n 各自触发 hanging", () => {
    const { stream, out } = makeStream();
    stream.feed("a\nb\nc");
    expect(stripAnsi(out.buffer)).toBe(
      `  ${ANCHOR_AI_DONE} a\n    b\n    c`,
    );
  });

  it("\\n 跨多次 feed 仍正确换行", () => {
    const { stream, out } = makeStream();
    stream.feed("a\n");
    stream.feed("b");
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} a\n    b`);
  });

  it("\\n\\n 双换行 = 段落分隔——中间是真空行（无 hanging 4 空格）", () => {
    const { stream, out } = makeStream();
    stream.feed("段一\n\n段二");
    expect(stripAnsi(out.buffer)).toBe(
      `  ${ANCHOR_AI_DONE} 段一\n\n    段二`,
    );
  });

  it("\\n\\n 跨 feed 段落分隔仍正确（不补 hanging 到空段）", () => {
    const { stream, out } = makeStream();
    stream.feed("段一\n");
    stream.feed("\n段二");
    expect(stripAnsi(out.buffer)).toBe(
      `  ${ANCHOR_AI_DONE} 段一\n\n    段二`,
    );
  });

  it("末尾 \\n 后下次 feed 起首补 hanging（同段续行）", () => {
    const { stream, out } = makeStream();
    stream.feed("段一\n");
    stream.feed("续行");
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} 段一\n    续行`);
  });

  it("起首 \\n 不创建空 ◆ 行——跳过到第一个可见字符位置写锚", () => {
    const { stream, out } = makeStream();
    stream.feed("\n你好");
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} 你好`);
  });

  it("起首多个 \\n + 空格全部跳过——锚紧跟第一个可见字符", () => {
    const { stream, out } = makeStream();
    stream.feed("\n\n  你好");
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} 你好`);
  });

  it("第一次 feed 全是 0 宽字符不输出——等下次 feed 有可见字符再起手", () => {
    const { stream, out } = makeStream();
    stream.feed("\n");
    expect(out.buffer).toBe("");
    stream.feed("你好");
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} 你好`);
  });

  it("起首之后再 feed 含 \\n 不跳过——保留段内换行结构", () => {
    const { stream, out } = makeStream();
    stream.feed("第一行");
    stream.feed("\n第二行");
    expect(stripAnsi(out.buffer)).toBe(
      `  ${ANCHOR_AI_DONE} 第一行\n    第二行`,
    );
  });

  // 起首跳过覆盖所有不可见字符 + 空白：\s + \p{Cc}（C0/C1 含 DEL）+ \p{Cf}（格式控制）。
  // 参数化覆盖各类代表性字符——证明 LLM 输出任何不可见起首都不让 ◆ 行视觉空。
  // 实证：MiniMax 等模型偶尔以 DEL 起首；其它模型可能用 BOM/ZWJ/LRM 等。
  it.each([
    // \p{Cc} 控制字符
    { name: "DEL (U+007F) —— 实证 LLM 偶发起首字符", char: "" },
    { name: "BS (U+0008) C0 控制", char: "" },
    { name: "C1 控制 (U+0085) NEL", char: "" },
    // \p{Cf} 格式控制字符
    { name: "ZWS (U+200B)", char: "​" },
    { name: "ZWNJ (U+200C)", char: "‌" },
    { name: "ZWJ (U+200D)", char: "‍" },
    { name: "LRM (U+200E)", char: "‎" },
    { name: "RLM (U+200F)", char: "‏" },
    { name: "PDF (U+202C) bidi 终止", char: "‬" },
    { name: "word joiner (U+2060)", char: "⁠" },
    { name: "BOM (U+FEFF)", char: "﻿" },
    { name: "soft hyphen (U+00AD)", char: "­" },
  ])("起首 $name 跳过——锚紧跟第一个可见字符", ({ char }) => {
    const { stream, out } = makeStream();
    stream.feed(`${char}你好`);
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} 你好`);
  });

  it("起首 DEL chunk 单独发送 + 后续 \\n\\n + 实质 chunk —— 实证还原 LLM 多 chunk 序列", () => {
    // 日志实证场景：LLM 三个 chunk 依次发送
    //   chunk 1: "" (DEL 单独)
    //   chunk 2: "\n\n"
    //   chunk 3: "你好"
    // 期望 ◆ 行紧跟"你好"，不应空。多 chunk 之间 hasStarted 仍 false 直到首个
    // 可见字符到达——LEADING_INVISIBLE trim 在每次 not hasStarted 的 feed 都重新执行。
    const { stream, out } = makeStream();
    stream.feed("");
    expect(out.buffer).toBe(""); // 全 trim 不输出
    stream.feed("\n\n");
    expect(out.buffer).toBe(""); // 仍全 trim
    stream.feed("你好");
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} 你好`);
  });

  it("起首多种 Cf 类 + \\n 混合——全部跳过，◆ 锚紧跟可见字符", () => {
    const { stream, out } = makeStream();
    // BOM + LRM + ZWJ + \n\n —— 各种 Unicode 不可见字符 + 换行混合
    stream.feed("﻿‎‍\n\n我是知行");
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} 我是知行`);
  });
});

describe("TextStream 软 wrap", () => {
  it("超 maxLineWidth 时插 \\n + hanging", () => {
    const { stream, out } = makeStream(20);
    stream.feed("a".repeat(50));
    expect(out.buffer).toContain("\n    ");
  });

  it("CJK 字符按 2 列计算 wrap", () => {
    // cols=30 → maxLineWidth = max(30-4, 20) = 26；20 个"你" = 40 列必 wrap
    const { stream, out } = makeStream(30);
    stream.feed("你".repeat(20));
    expect(out.buffer).toContain("\n    ");
  });

  it("窄终端不破——maxLineWidth 至少 20 列保护", () => {
    const { stream, out } = makeStream(5);
    stream.feed("hello world this is a long line");
    expect(out.buffer.length).toBeGreaterThan(0);
  });
});

describe("TextStream end", () => {
  it("已起首时 end 写末尾换行", () => {
    const { stream, out } = makeStream();
    stream.feed("hello");
    stream.end();
    expect(out.buffer.endsWith("\n")).toBe(true);
  });

  it("未起首时 end 不写", () => {
    const { stream, out } = makeStream();
    stream.end();
    expect(out.buffer).toBe("");
  });

  it("end 后再 feed 重新起首插锚", () => {
    const { stream, out } = makeStream();
    stream.feed("first");
    stream.end();
    stream.feed("second");
    const anchorMatches = out.buffer.match(/◆/g) ?? [];
    expect(anchorMatches.length).toBe(2);
  });
});
