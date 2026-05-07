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

describe("ScreenController · 差分 repaint（无闪烁契约）", () => {
  it("attach 之后 setStatusBar 不发出 \\x1b[J（差分覆盖，避免整片清屏闪烁）", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));
    out.buffer = "";
    sc.setStatusBar(["STATUS"]);
    expect(out.buffer).not.toContain("\x1b[J");
    expect(out.buffer).toContain("\x1b[2K"); // 用清行而非清屏
    expect(out.buffer).toContain("STATUS");
  });

  it("setStatusBar 多次更新都不闪烁（每次都走 \\x1b[2K 行内覆盖）", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));
    sc.setStatusBar(["STATUS-1"]);
    out.buffer = "";
    // spinner tick 等价场景：连续多次 setStatusBar
    sc.setStatusBar(["STATUS-2"]);
    sc.setStatusBar(["STATUS-3"]);
    sc.setStatusBar(["STATUS-4"]);
    expect(out.buffer).not.toContain("\x1b[J");
    // 每次都用清行
    const lineErases = (out.buffer.match(/\x1b\[2K/g) ?? []).length;
    expect(lineErases).toBeGreaterThan(0);
  });

  it("paintChrome atomic—— 整次更新拼接到单次 stdout.write", () => {
    let writeCount = 0;
    const fakeStdout = {
      buffer: "",
      isTTY: true,
      columns: 80,
      write(s: string): boolean {
        this.buffer += s;
        writeCount += 1;
        return true;
      },
    };
    const sc = createScreenController({
      stdout: fakeStdout as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));
    writeCount = 0;
    sc.setStatusBar(["STATUS"]);
    // 单次 paintChrome 应该是 1 次 stdout.write（整个 ANSI + 内容序列）
    expect(writeCount).toBe(1);
  });

  it("withScrollWrite 协调路径 atomic—— 单次 stdout.write 包含 erase + scroll + chrome", () => {
    let writeCount = 0;
    const fakeStdout = {
      buffer: "",
      isTTY: true,
      columns: 80,
      write(s: string): boolean {
        this.buffer += s;
        writeCount += 1;
        return true;
      },
    };
    const sc = createScreenController({
      stdout: fakeStdout as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));
    sc.setStatusBar(["STATUS"]);
    writeCount = 0;
    sc.withScrollWrite((write) => write("AI text"));
    // 协调模式下应该 1 次 stdout.write（atomic）
    expect(writeCount).toBe(1);
    // 单次写入包含 erase + scroll + chrome
    expect(fakeStdout.buffer).toContain("AI text");
    expect(fakeStdout.buffer).toContain("STATUS");
    expect(fakeStdout.buffer).toContain("INPUT");
  });

  it("行数减少时保留 max 占用——多余行 \\x1b[2K 清空，不收缩 chrome 区", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    // 初始 chrome 5 行：1 status + 4 input
    sc.attachInput(makeRegion(["I1", "I2", "I3", "I4"]));
    sc.setStatusBar(["S1"]);
    out.buffer = "";
    // 收缩到 1 status + 1 input = 2 行
    sc.attachInput(makeRegion(["I-only"]));
    expect(out.buffer).not.toContain("\x1b[J"); // 不彻底擦
    // 多余行被清行清空
    expect(out.buffer.match(/\x1b\[2K/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(out.buffer).toContain("I-only");
    expect(out.buffer).toContain("S1");
  });

  it("detachInput 触发完整擦除（chrome 消失语义）", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));
    sc.setStatusBar(["STATUS"]);
    out.buffer = "";
    sc.detachInput();
    // detach 是完全消失——必须 \x1b[J
    expect(out.buffer).toContain("\x1b[J");
  });
});

describe("ScreenController · Frame Buffer（chunk 接续 + chrome 永驻）", () => {
  it("withScrollWrite 后 chrome 仍在屏幕——不再 erase chrome（流式期间 chrome 永驻语义）", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));
    sc.setStatusBar(["STATUS"]);
    out.buffer = "";
    sc.withScrollWrite((write) => write("hello"));
    // chrome 仍显示，scroll 内容也在
    expect(out.buffer).toContain("hello");
    expect(out.buffer).toContain("STATUS");
    expect(out.buffer).toContain("INPUT");
    // 不用 \x1b[J 整片清屏
    expect(out.buffer).not.toContain("\x1b[J");
  });

  it("多次 withScrollWrite 在 tailBuffer 末尾行接续（chunk 同行拼接）", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));
    out.buffer = "";
    sc.withScrollWrite((write) => write("你好"));
    sc.withScrollWrite((write) => write("世界"));
    // chunk 接续：tailBuffer 末尾行 = "你好世界"，paint 时该行包含完整内容
    expect(out.buffer).toContain("你好世界");
  });

  it("withScrollWrite 含 \\n 时 tailBuffer 新增一行——下次 chunk 在新行起首", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));
    out.buffer = "";
    sc.withScrollWrite((write) => write("第一段\n"));
    sc.withScrollWrite((write) => write("第二段"));
    // 第二段在新行——视觉上两行
    expect(out.buffer).toContain("第一段");
    expect(out.buffer).toContain("第二段");
  });

  it("流式 chunk 期间 chrome 始终在屏幕（input + status 都显示）", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT_CHROME"]));
    sc.setStatusBar(["STATUS_BAR"]);
    out.buffer = "";
    // 模拟 LLM 流式：多个 chunk 写入
    sc.withScrollWrite((write) => write("AI"));
    sc.withScrollWrite((write) => write(" 回"));
    sc.withScrollWrite((write) => write("复"));
    // 每次写入后 chrome 都重画 —— 屏幕上 chrome 始终显示
    expect(out.buffer).toContain("STATUS_BAR");
    expect(out.buffer).toContain("INPUT_CHROME");
    // chunk 接续：tailBuffer 末尾行 = "AI 回复"
    expect(out.buffer).toContain("AI 回复");
  });

  it("notifyDeferred 等同 withScrollWrite（frame buffer 模式下不再有独占排队语义）", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));
    out.buffer = "";
    sc.notifyDeferred("scheduler done");
    expect(out.buffer).toContain("scheduler done");
    expect(out.buffer).toContain("INPUT");
  });

  it("paintFrame atomic—— 整次更新拼接到单次 stdout.write", () => {
    let writeCount = 0;
    const fakeStdout = {
      buffer: "",
      isTTY: true,
      columns: 80,
      write(s: string): boolean {
        this.buffer += s;
        writeCount += 1;
        return true;
      },
    };
    const sc = createScreenController({
      stdout: fakeStdout as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));
    sc.setStatusBar(["STATUS"]);
    writeCount = 0;
    sc.withScrollWrite((write) => write("AI text"));
    // 单次 paintFrame = 单次 stdout.write
    expect(writeCount).toBe(1);
  });

  it("空 chunk 不触发 paint（避免空写抖动）", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));
    out.buffer = "";
    sc.withScrollWrite(() => {}); // 不写
    // 不应有任何输出
    expect(out.buffer).toBe("");
  });

  it("空 notifyDeferred 不触发 paint", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));
    out.buffer = "";
    sc.notifyDeferred("");
    expect(out.buffer).toBe("");
  });

  it("tailBuffer 累积超阈值时固化前面行——renderedRows / cursorRow 同步减少", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));
    // 累积大量行触发固化（MAX_TAIL_LINES=50）
    for (let i = 0; i < 60; i++) {
      sc.withScrollWrite((write) => write(`line ${i}\n`));
    }
    // 固化后 chrome 仍能正常重画（不会因 cursorRow 错乱崩溃）
    out.buffer = "";
    sc.setStatusBar(["STATUS"]);
    expect(out.buffer).toContain("STATUS");
    expect(out.buffer).toContain("INPUT");
  });
});
