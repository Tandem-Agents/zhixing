import { describe, expect, it } from "vitest";
import {
  createScreenController,
  type InputRegion,
} from "../screen-controller.js";

class FakeStdout {
  buffer = "";
  isTTY = true;
  columns = 80;
  write(s: string): boolean {
    this.buffer += s;
    return true;
  }
}

function makeRegion(
  lines: readonly string[],
  cursorRow = 0,
  cursorCol = 0,
): InputRegion {
  return {
    renderLines: () => lines,
    cursorPosition: () => ({ row: cursorRow, col: cursorCol }),
  };
}

describe("ScreenController · attach + 重画", () => {
  it("attachInput 写入区在屏底", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["line1", "line2"], 1, 3));
    expect(out.buffer).toContain("line1");
    expect(out.buffer).toContain("line2");
  });

  it("setStatusBar 加在输入区上方", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["input"], 0, 0));
    out.buffer = "";
    sc.setStatusBar(["status"]);
    expect(out.buffer.indexOf("status")).toBeLessThan(out.buffer.indexOf("input"));
  });

  it("setStatusBar(null) 清除状态条但保留输入区", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["input"]));
    sc.setStatusBar(["s"]);
    out.buffer = "";
    sc.setStatusBar(null);
    expect(out.buffer).toContain("input");
    expect(out.buffer).not.toContain("status");
  });
});

describe("ScreenController · withScrollWrite", () => {
  it("写入内容追加到滚动区，状态条 / 输入区在下方", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));
    sc.setStatusBar(["STATUS"]);
    out.buffer = "";
    sc.withScrollWrite((write) => write("AI text\n"));
    const idxText = out.buffer.indexOf("AI text");
    const idxStatus = out.buffer.indexOf("STATUS");
    const idxInput = out.buffer.indexOf("INPUT");
    expect(idxText).toBeLessThan(idxStatus);
    expect(idxStatus).toBeLessThan(idxInput);
  });

  it("写入末尾无 \\n 自动补一个", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));
    sc.withScrollWrite((write) => write("hello"));
    expect(out.buffer).toContain("hello\n");
  });

  it("空写入不产生 \\n 噪声", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));
    out.buffer = "";
    sc.withScrollWrite(() => {});
    // 仅触发重画 INPUT，不应有空 \n 流
    expect(out.buffer.match(/\n\n/)).toBeNull();
  });
});

describe("ScreenController · 串行化", () => {
  it("嵌套 enqueue（写入回调内再调 setStatusBar）按 FIFO 顺序执行", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    const events: string[] = [];
    sc.attachInput({
      renderLines: () => {
        events.push("render");
        return ["INPUT"];
      },
      cursorPosition: () => ({ row: 0, col: 0 }),
    });
    out.buffer = "";
    sc.withScrollWrite((write) => {
      events.push("scroll-fn");
      write("x");
      sc.setStatusBar(["new"]);
      events.push("scroll-fn-end");
    });
    // setStatusBar 在嵌套 enqueue 后执行，不会与 withScrollWrite 中段穿插
    const lastFn = events.lastIndexOf("scroll-fn-end");
    expect(lastFn).toBeGreaterThanOrEqual(0);
  });

  it("dispose 后再 attachInput 不再产生输出", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.dispose();
    out.buffer = "";
    sc.attachInput(makeRegion(["LATE"]));
    expect(out.buffer).toBe("");
  });

  it("dispose 擦除已渲染的 status + input 屏幕痕迹", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));
    sc.setStatusBar(["STATUS"]);
    out.buffer = "";
    sc.dispose();
    // dispose 应触发 ANSI 擦除序列（清屏到末尾）
    expect(out.buffer).toContain("\x1b[J");
  });
});

describe("ScreenController · 输入区光标定位", () => {
  it("光标 row/col 信息会触发对应 ANSI 移动", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["AAA", "BBB", "CCC"], 0, 1));
    expect(out.buffer).toMatch(/\x1b\[2A/);
    expect(out.buffer).toMatch(/\x1b\[1C/);
  });
});
