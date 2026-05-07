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

  it("第一次 feed 起首是 \\n 时 trim 掉——◆ 锚紧跟实际内容（不分行）", () => {
    const { stream, out } = makeStream();
    stream.feed("\n你好");
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} 你好`);
  });

  it("第一次 feed 起首多个 \\n + 空格都 trim 掉", () => {
    const { stream, out } = makeStream();
    stream.feed("\n\n  你好");
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} 你好`);
  });

  it("第一次 feed 全空白等下次有实际内容再起首", () => {
    const { stream, out } = makeStream();
    stream.feed("\n");
    // 全空白没有实际内容——不写起首锚，等下次
    expect(out.buffer).toBe("");
    stream.feed("你好");
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} 你好`);
  });

  it("起首之后再 feed 含 \\n 不 trim——保留段内换行结构", () => {
    const { stream, out } = makeStream();
    stream.feed("第一行");
    stream.feed("\n第二行");
    expect(stripAnsi(out.buffer)).toBe(
      `  ${ANCHOR_AI_DONE} 第一行\n    第二行`,
    );
  });

  it("起首零宽度字符（U+200B / BOM）也被 trim——避免 ◆ 锚后跟不可见字符让 ◆ 行视觉空", () => {
    const { stream, out } = makeStream();
    // U+200B (zero-width space) + \n\n + 实际内容——LLM 偶尔输出此模式
    stream.feed("​\n\n你好");
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} 你好`);
  });

  it("起首 BOM (U+FEFF) 被 trim", () => {
    const { stream, out } = makeStream();
    stream.feed("﻿你好");
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} 你好`);
  });

  it("起首 zero-width joiner 也被 trim", () => {
    const { stream, out } = makeStream();
    stream.feed("‍你好");
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} 你好`);
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
