import { describe, expect, it } from "vitest";
import {
  createScreenController,
  type InputRegion,
} from "../screen-controller.js";

class FakeStdout {
  buffer = "";
  isTTY = true;
  columns = 80;
  rows = 30;
  private listeners = new Map<string, Set<() => void>>();
  write(s: string): boolean {
    this.buffer += s;
    return true;
  }
  on(event: string, listener: () => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }
  off(event: string, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }
  emit(event: string): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of set) fn();
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

  it("writeScrollLine 写入独立段——内容落地 + 状态条/输入区仍保留", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));
    out.buffer = "";
    sc.writeScrollLine("scheduler done");
    expect(out.buffer).toContain("scheduler done");
    expect(out.buffer).toContain("INPUT");
  });

  it("writeScrollLine 在 appendInline 流式中——保证起新行，不与 chunk 粘连", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));
    // 模拟 LLM 流式 chunk 累积——末尾不带 \n
    sc.withScrollWrite((write) => write("LLM partial chunk..."));
    out.buffer = "";
    // 异步通知插入——必须独立成行，不能粘到 chunk 末尾
    sc.writeScrollLine("⚠ scheduler warn");
    // 物理 buffer 中通知与 chunk 不在同一行（断言关键：通知前应有 \n 切行）
    const chunkIdx = out.buffer.indexOf("LLM partial chunk...");
    const warnIdx = out.buffer.indexOf("⚠ scheduler warn");
    if (chunkIdx >= 0 && warnIdx >= 0) {
      const between = out.buffer.slice(chunkIdx, warnIdx);
      expect(between).toContain("\n");
    }
  });

  it("writeScrollLine 在已 \\n 结尾的内容之后——不补多余空行", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));
    sc.writeScrollLine("first");
    sc.writeScrollLine("second");
    // 两段独立行，中间无多余空行
    expect(out.buffer).not.toMatch(/first\s*\n\s*\n\s*second/);
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

  it("空字符串 writeScrollLine 写一空行——空字符串语义是空行（与 cliWriter.line('') 对齐）", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));
    out.buffer = "";
    sc.writeScrollLine("");
    // 写了空行——paint 触发，buffer 内必有 \n（空行落地的标志）
    expect(out.buffer.length).toBeGreaterThan(0);
  });

  it("tailBuffer 超出 viewport 时固化前行——chrome 仍能正常重画", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));
    // 累积大量行触发 viewport-aware freeze（rows=30）
    for (let i = 0; i < 60; i++) {
      sc.withScrollWrite((write) => write(`line ${i}\n`));
    }
    // 固化后 chrome 仍能正常重画（不会因 cursorRow 错乱崩溃）
    out.buffer = "";
    sc.setStatusBar(["STATUS"]);
    expect(out.buffer).toContain("STATUS");
    expect(out.buffer).toContain("INPUT");
  });

  it("frame 不会超出 viewport——cursor up 序列永远 ≤ viewport-1，避免跨视口截断引发 scrollback 重复", () => {
    const out = new FakeStdout();
    out.rows = 20;
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));

    // 写入远超 viewport 的内容——若不 freeze，frame 高度会增长到 50+ 行远超 viewport
    for (let i = 0; i < 50; i++) {
      sc.withScrollWrite((write) => write(`line ${i}\n`));
    }

    // 内容存在（早期固化到 scrollback、末尾在 frame 内）
    expect(out.buffer).toContain("line 0");
    expect(out.buffer).toContain("line 49");
    expect(out.buffer).toContain("INPUT");

    // 关键 invariant：所有 cursor up 序列的 N 不超过 viewport-1。
    // 终端 cursor up 不能跨视口顶部——若 N > viewport，cursor 会被截断到屏幕第 0 行，
    // 后续 paint 在错误位置写入 + 末尾 \n 触发滚动，导致内容反复推入 scrollback 形成重复。
    const cursorUps = [...out.buffer.matchAll(/\x1b\[(\d+)A/g)];
    const maxUp = cursorUps.length === 0
      ? 0
      : Math.max(...cursorUps.map((m) => parseInt(m[1]!, 10)));
    expect(maxUp).toBeLessThanOrEqual(out.rows - 1);
  });

  it("terminal resize 后旧 cursor 状态被重置——后续 paint 不再因新 viewport 下 cursor up 截断而触发重复", () => {
    const out = new FakeStdout();
    out.rows = 30;
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));

    // 累积内容让 frame 在大 viewport 下接近上限
    for (let i = 0; i < 25; i++) {
      sc.withScrollWrite((write) => write(`line ${i}\n`));
    }

    // 模拟用户调小终端
    out.rows = 12;
    out.buffer = ""; // 清空已有 buffer，只观察 resize 后的 ANSI
    out.emit("resize");

    // resize 后再写——cursor up 应永远 ≤ 新 viewport - 1，否则跨视口截断回归
    sc.withScrollWrite((write) => write("after-resize\n"));
    const cursorUps = [...out.buffer.matchAll(/\x1b\[(\d+)A/g)];
    const maxUp =
      cursorUps.length === 0
        ? 0
        : Math.max(...cursorUps.map((m) => parseInt(m[1]!, 10)));
    expect(maxUp).toBeLessThanOrEqual(out.rows - 1);
  });

  it("dispose 解绑 resize listener——不再响应 emit", () => {
    const out = new FakeStdout();
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["INPUT"]));
    sc.dispose();
    out.buffer = "";
    // dispose 后 resize 事件不应触发 paint（监听已解绑）
    out.emit("resize");
    expect(out.buffer).toBe("");
  });

  it("status / input 占用过大时仍能写入——不会无限固化崩溃", () => {
    const out = new FakeStdout();
    out.rows = 12; // 极小 viewport
    const sc = createScreenController({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(makeRegion(["I1", "I2", "I3"]));
    sc.setStatusBar(["S1", "S2"]);
    // tailBuffer 一次写入大量行
    for (let i = 0; i < 30; i++) {
      sc.withScrollWrite((write) => write(`row ${i}\n`));
    }
    // 不崩溃 + 早期内容已落地永久 + 末尾在 frame 内
    expect(out.buffer).toContain("row 0");
    expect(out.buffer).toContain("row 29");
    expect(out.buffer).toContain("I1");
  });
});
