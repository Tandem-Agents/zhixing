import { describe, expect, it } from "vitest";
import { TextStream } from "../text-stream.js";
import { ANCHOR_AI_DONE } from "../speaker-state.js";
import { stripAnsi } from "../../tui/ansi.js";

class FakeStdout {
  buffer = "";
  isTTY = true;
  columns: number;
  constructor(cols: number) {
    this.columns = cols;
  }
  write(s: string): boolean {
    this.buffer += s;
    return true;
  }
}

function makeStream(cols = 80): { stream: TextStream; out: FakeStdout } {
  const out = new FakeStdout(cols);
  const stream = new TextStream({
    stdout: out as unknown as NodeJS.WriteStream,
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
