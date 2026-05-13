import { describe, expect, it } from "vitest";
import {
  createScreenController,
  type InputRegion,
  type ScreenController,
} from "../screen-controller.js";
import type { TerminalCapability } from "../terminal-capability.js";

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

function makeCapability(
  rows = 30,
  cols = 80,
): TerminalCapability {
  return {
    viewport: { rows, cols },
    platform: "linux",
    tmux: false,
  };
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

interface TestHarness {
  out: FakeStdout;
  sc: ScreenController;
}

function makeHarness(opts: { rows?: number; cols?: number } = {}): TestHarness {
  const out = new FakeStdout();
  out.rows = opts.rows ?? 30;
  out.columns = opts.cols ?? 80;
  const sc = createScreenController({
    capability: makeCapability(out.rows, out.columns),
    stdout: out as unknown as NodeJS.WriteStream,
  });
  return { out, sc };
}

describe("ScreenController · 构造 + capability 注入", () => {
  it("构造期不写任何字节（ScrollRegion 未启动）", () => {
    const { out } = makeHarness();
    expect(out.buffer).toBe("");
  });

  it("构造接受 capability + stdout 注入——后续操作走该 stdout", () => {
    const { out, sc } = makeHarness();
    sc.writeScrollLine("hello");
    // pre-attach 缓冲：writeScrollLine 不直写
    expect(out.buffer).toBe("");
  });
});

describe("ScreenController · pre-attach 缓冲（启动期 cliWriter 调用）", () => {
  it("attach 之前 writeScrollLine 内容被缓冲不直写 stdout", () => {
    const { out, sc } = makeHarness();
    sc.writeScrollLine("welcome line 1");
    sc.writeScrollLine("welcome line 2");
    expect(out.buffer).toBe("");
  });

  it("attach 之前 withScrollWrite 内容被缓冲", () => {
    const { out, sc } = makeHarness();
    sc.withScrollWrite((write) => write("partial"));
    expect(out.buffer).toBe("");
  });

  it("attach 之前 setStatusBar 仅记录引用、不写字节", () => {
    const { out, sc } = makeHarness();
    sc.setStatusBar(["status line"]);
    expect(out.buffer).toBe("");
  });

  it("首次 attachInput 时清 scrollback + 清 viewport + DECSTBM + flush 缓冲内容", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.writeScrollLine("welcome");
    sc.attachInput(makeRegion(["> input"]));
    // 启动序列 = \x1b[3J（清 scrollback）+ \x1b[2J（清 viewport）+ \x1b[1;1H（cursor 顶）
    expect(out.buffer).toContain("\x1b[2J\x1b[3J\x1b[1;1H");
    expect(out.buffer).toContain("\x1b[1;9r"); // DECSTBM 1..(rows-chromeHeight) = 1..9
    expect(out.buffer).toContain("welcome\n"); // flush 缓冲内容
    expect(out.buffer).toContain("> input"); // chrome 输入行
  });
});

describe("ScreenController · attachInput", () => {
  it("无缓冲时 attach 清 scrollback + 清 viewport + DECSTBM + chrome", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    expect(out.buffer).toContain("\x1b[2J\x1b[3J\x1b[1;1H");
    expect(out.buffer).toContain("\x1b[1;9r"); // chromeHeight=1, scrollBottom=9
    expect(out.buffer).toContain("> input");
  });

  it("重复 attachInput（替换 input）触发 chrome 高度协议", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> a"]));
    out.buffer = "";
    sc.attachInput(makeRegion(["> b1", "> b2"])); // 高度从 1 → 2
    // 不再走启动序列（首次 attach 已完成 + ScrollRegion 仍 attached）
    expect(out.buffer).not.toContain("\x1b[3J");
    expect(out.buffer).not.toContain("\x1b[2J");
    // 但应该 setChromeHeight 重设 DECSTBM
    expect(out.buffer).toContain("\x1b[1;8r"); // chromeHeight=2, scrollBottom=8
    expect(out.buffer).toContain("> b1");
    expect(out.buffer).toContain("> b2");
  });

  it("attach 后 input cursor 由 ScreenController 显式 emit", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"], 0, 2));
    // input cursor 在 row scrollBottom+1+0=10, col 1+2=3
    expect(out.buffer).toContain("\x1b[10;3H");
  });
});

describe("ScreenController · 硬件光标可见性 SoT（chrome 模式永久隐藏）", () => {
  // chrome 模式下硬件光标永久隐藏，输入光标由 InputController 通过 reverse SGR
  // 画在 chrome body 内承担——消除"输出区底行光标 + 输入光标随输出 chunk 闪烁"
  // 双现象的根本架构。本组测试守住四个生命周期 emit 点的不变量。

  it("firstAttach 末尾 emit hideCursor —— chrome 模式建立", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    expect(out.buffer).toContain("\x1b[?25l");
    // hideCursor 必须在 FIRSTATTACH_SEQUENCE 之后（顺序：清屏 → 隐藏 → DECSTBM/chrome）
    const idxClear = out.buffer.indexOf("\x1b[2J\x1b[3J\x1b[1;1H");
    const idxHide = out.buffer.indexOf("\x1b[?25l");
    expect(idxClear).toBeGreaterThanOrEqual(0);
    expect(idxHide).toBeGreaterThan(idxClear);
  });

  it("detachInput emit showCursor —— shell 接管干净状态", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    out.buffer = "";
    sc.detachInput();
    expect(out.buffer).toContain("\x1b[?25h");
  });

  it("pre-attach 的 detachInput 不 emit showCursor（保护 shell 原状）", () => {
    const { out, sc } = makeHarness();
    sc.detachInput();
    // pre-attach 路径未 hideCursor → 对偶不 showCursor，零字节写入
    expect(out.buffer).toBe("");
  });

  it("resume 末尾重新 emit hideCursor —— modal 退出后重新断言 chrome 不变量", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.suspend();
    out.buffer = "";
    sc.resume();
    expect(out.buffer).toContain("\x1b[?25l");
  });

  it("dispose（attached 路径）emit showCursor —— 进程退出前最终恢复", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    out.buffer = "";
    sc.dispose();
    expect(out.buffer).toContain("\x1b[?25h");
  });

  it("dispose（detached 路径）仍 emit showCursor —— everAttached 兜底语义", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.detachInput();
    out.buffer = "";
    sc.dispose();
    expect(out.buffer).toContain("\x1b[?25h");
  });

  it("dispose（pre-attach 路径，everAttached=false）不写任何字节（保护 shell 原状）", () => {
    const { out, sc } = makeHarness();
    sc.dispose();
    expect(out.buffer).toBe("");
  });
});

describe("ScreenController · ensureScrollLeadingBlank（段间空行幂等保证）", () => {
  // 修复 LLM → user echo 紧贴 bug 的核心 API。基于 ScrollRegion 视觉行级
  // tail state 决定补 0/1/2 个 \n，幂等保护既有正确路径。

  it("已有空行（trailingBlankRows ≥ 1）→ no-op，不写任何字节", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    // 写一段 + 空行 = trailingBlankRows=1
    sc.writeScrollLine("hello");
    sc.writeScrollLine("");
    out.buffer = "";
    sc.ensureScrollLeadingBlank();
    // 不应有任何字节写出（光标定位是 repaintInputCursor 触发的，本 API 不调）
    expect(out.buffer).toBe("");
  });

  it("无空行（trailingBlankRows = 0，上一行有内容）→ 补 1 个 \\n", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.writeScrollLine("hello"); // trailingBlankRows=0
    out.buffer = "";
    sc.ensureScrollLeadingBlank();
    // 应包含一个 \n（通过 appendInline 写入，附带 cursor 定位序列）
    expect(out.buffer).toContain("\n");
    // 不应有多个 \n（仅补 1 个）
    expect(out.buffer.split("\n").length - 1).toBe(1);
  });

  it("cursor mid-line（currentRowHasVisible=true）→ 补 2 个 \\n（收口 + 空行）", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.withScrollWrite((write) => write("partial chunk"));
    out.buffer = "";
    sc.ensureScrollLeadingBlank();
    expect(out.buffer.split("\n").length - 1).toBe(2);
  });

  it("pre-attach 状态：ensureScrollLeadingBlank 不写字节（无 attached region 可写）", () => {
    const { out, sc } = makeHarness();
    sc.ensureScrollLeadingBlank();
    expect(out.buffer).toBe("");
  });

  it("LLM 输出后调用 → 补 1 个 \\n（模拟 echoSubmittedDraft 真实场景）", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    // 模拟 LLM mdStream.end() 末尾 \n（trailingBlankRows=0 之后）
    sc.withScrollWrite((write) => write("LLM 回答内容\n"));
    out.buffer = "";
    sc.ensureScrollLeadingBlank();
    expect(out.buffer.split("\n").length - 1).toBe(1);
  });

  it("chalk.dim 包住 \\n 的 handler 输出后调用 → no-op（不 regression）", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    // 模拟 cliWriter.line(chalk.dim("对话历史已清空\n")) 路径
    // writeScrollLine 会 ensure \n → 实际 emit 为 "\x1b[2m..\n\x1b[22m\n"
    sc.writeScrollLine("\x1b[2m对话历史已清空\n\x1b[22m");
    out.buffer = "";
    sc.ensureScrollLeadingBlank();
    // stripAnsi 后视觉行级判定：trailingBlankRows ≥ 1 → no-op
    expect(out.buffer).toBe("");
  });
});

describe("ScreenController · setStatusBar", () => {
  it("attach 之前 setStatusBar 只记录引用，attach 时被读到", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.setStatusBar(["S1", "S2"]);
    sc.attachInput(makeRegion(["> input"]));
    // chromeHeight = 2 status + 1 input = 3, scrollBottom = 7
    expect(out.buffer).toContain("\x1b[1;7r");
    expect(out.buffer).toContain("S1");
    expect(out.buffer).toContain("S2");
  });

  it("attach 后 setStatusBar 触发 chrome 高度协议", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    out.buffer = "";
    sc.setStatusBar(["status"]);
    // chrome 从 1 → 2, scrollBottom 9 → 8
    expect(out.buffer).toContain("\x1b[1;8r");
    expect(out.buffer).toContain("status");
  });

  it("setStatusBar(null) 清空状态条", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.setStatusBar(["status"]);
    out.buffer = "";
    sc.setStatusBar(null);
    // chrome 从 2 → 1
    expect(out.buffer).toContain("\x1b[1;9r");
  });
});

describe("ScreenController · setStatusTail（按 id 注册多段：单段语义）", () => {
  it("statusLines 非空 + tail 非空：tail 拼到第一行末尾，chrome 高度不变", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.setStatusBar(["S1", "S2"]);
    out.buffer = "";
    sc.setStatusTail("task", "TAIL");
    // chrome 起手行 = scrollBottom + 1 = (rows - chromeHeight) + 1 = (10 - 3) + 1 = 8
    // —— 与 setStatusTail 调用前一致，说明 chromeHeight 没变（仍是 3）
    expect(out.buffer).toContain("\x1b[8;1H");
    // tail 拼到 S1 末尾（含 │ 分隔符）；S2 不动
    expect(out.buffer).toContain("S1");
    expect(out.buffer).toContain("│");
    expect(out.buffer).toContain("TAIL");
    expect(out.buffer).toContain("S2");
  });

  it("statusLines 空 + tail 非空：tail 独立成行（chrome 高度 = 1 tail + input）", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    out.buffer = "";
    sc.setStatusTail("task", "TAIL");
    // chrome 从 1 (input) → 2 (tail + input)，scrollBottom 9 → 8
    expect(out.buffer).toContain("\x1b[1;8r");
    expect(out.buffer).toContain("TAIL");
    // 单段独立显示时不应有 │ 分隔符
    expect(out.buffer).not.toContain("│");
  });

  it("tail 独立显示加 contentPrefix（与 cli 全局对齐契约一致）", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    out.buffer = "";
    sc.setStatusTail("task", "X");
    // contentPrefix 是两空格 —— tail 行起手应有 "  X"
    expect(out.buffer).toMatch(/\x1b\[\d+;1H\x1b\[2K {2}X/);
  });

  it("setStatusTail(id, null) 移除该段（chrome 高度回退）", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.setStatusTail("task", "TAIL");
    out.buffer = "";
    sc.setStatusTail("task", null);
    // chrome 从 2 (tail + input) → 1 (input only)，scrollBottom 8 → 9
    expect(out.buffer).toContain("\x1b[1;9r");
  });

  it("setStatusTail(id, 空字符串) 等同 null（移除该段）", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.setStatusTail("task", "TAIL");
    out.buffer = "";
    sc.setStatusTail("task", "");
    expect(out.buffer).toContain("\x1b[1;9r");
  });

  it("setStatusTail 幂等：同 id 同值连续调用不重画", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.setStatusTail("task", "TAIL");
    out.buffer = "";
    sc.setStatusTail("task", "TAIL");
    // 相同值 → 跳过 refreshChrome → 无 ANSI 输出
    expect(out.buffer).toBe("");
  });

  it("setStatusTail 幂等：同 id 持续不存在 + null 不重画", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    out.buffer = "";
    sc.setStatusTail("task", null);
    // 段本就不存在 → 跳过 refreshChrome → 无 ANSI 输出
    expect(out.buffer).toBe("");
  });

  it("statusBar 和 statusTail 同时变化：拼接结果两者都在", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.setStatusBar(["STATUS"]);
    sc.setStatusTail("task", "TAIL");
    expect(out.buffer).toContain("STATUS");
    expect(out.buffer).toContain("TAIL");
  });

  it("attach 前 setStatusTail 入队，attach 时被读到", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.setStatusTail("task", "TAIL");
    sc.attachInput(makeRegion(["> input"]));
    // chrome = 1 tail + 1 input = 2，scrollBottom = 8
    expect(out.buffer).toContain("\x1b[1;8r");
    expect(out.buffer).toContain("TAIL");
  });

  it("detachInput 后 statusTail 被清理（重新 attach 不复活）", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.setStatusTail("task", "OLD_TAIL");
    sc.detachInput();
    out.buffer = "";
    sc.attachInput(makeRegion(["> input"]));
    expect(out.buffer).not.toContain("OLD_TAIL");
  });

  it("超长行被 clampLine 截断，不超 viewportCols-1", () => {
    const { out, sc } = makeHarness({ rows: 10, cols: 30 });
    sc.attachInput(makeRegion(["> input"]));
    out.buffer = "";
    sc.setStatusTail("task", "a".repeat(100));
    // 找出 tail 行：以 \x1b[<row>;1H\x1b[2K 开头并含 a 的段
    const tailMatch = out.buffer.match(/\x1b\[2K(  a+\S*)/);
    expect(tailMatch).toBeTruthy();
    // visible width <= viewportCols - 1 (= 29)
    expect(tailMatch![1]!.replace(/[^a]/g, "").length).toBeLessThanOrEqual(28);
  });
});

describe("ScreenController · setStatusTail 多段拼接（task + context 协议）", () => {
  it("多段拼接：按首次注册顺序保序", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.setStatusBar(["STATUS"]);
    out.buffer = "";
    sc.setStatusTail("task", "TASK_SEG");
    sc.setStatusTail("context", "~ 14k");
    // STATUS │ TASK_SEG │ ~ 14k —— 顺序由首次注册决定
    const idxStatus = out.buffer.indexOf("STATUS");
    const idxTask = out.buffer.indexOf("TASK_SEG");
    const idxCtx = out.buffer.indexOf("~ 14k");
    expect(idxStatus).toBeGreaterThanOrEqual(0);
    expect(idxTask).toBeGreaterThan(idxStatus);
    expect(idxCtx).toBeGreaterThan(idxTask);
  });

  it("多段拼接：相同 id 更新位置不变（不会被挪到末尾）", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.setStatusBar(["STATUS"]);
    sc.setStatusTail("task", "TASK_SEG_OLD");
    sc.setStatusTail("context", "CTX_SEG");
    out.buffer = "";
    sc.setStatusTail("task", "TASK_SEG_NEW");
    // task 段更新后位置仍在 context 之前
    const idxTask = out.buffer.indexOf("TASK_SEG_NEW");
    const idxCtx = out.buffer.indexOf("CTX_SEG");
    expect(idxTask).toBeGreaterThan(0);
    expect(idxCtx).toBeGreaterThan(idxTask);
  });

  it("多段拼接：移除一段不影响其他段", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.setStatusTail("task", "TASK_SEG");
    sc.setStatusTail("context", "CTX_SEG");
    out.buffer = "";
    sc.setStatusTail("task", null);
    // task 移除后剩 context；上下文段独立显示
    expect(out.buffer).not.toContain("TASK_SEG");
    expect(out.buffer).toContain("CTX_SEG");
  });

  it("多段拼接：全部移除后等同无 tail（chrome 高度回退）", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.setStatusTail("task", "TASK_SEG");
    sc.setStatusTail("context", "CTX_SEG");
    out.buffer = "";
    sc.setStatusTail("task", null);
    sc.setStatusTail("context", null);
    // 双段全空 → 仅 input 在 chrome → scrollBottom = 9
    expect(out.buffer).toContain("\x1b[1;9r");
  });

  it("多段拼接：statusLines 空 + 两段非空 → 独立成行包含双段", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    out.buffer = "";
    sc.setStatusTail("task", "TASK");
    sc.setStatusTail("context", "CTX");
    // tail 独立成行（chrome 高度 = 2: tail + input）
    expect(out.buffer).toContain("\x1b[1;8r");
    expect(out.buffer).toContain("TASK");
    expect(out.buffer).toContain("CTX");
    // 多段独立成行时必含 │ 分隔符
    expect(out.buffer).toContain("│");
  });
});

describe("ScreenController · writeScrollLine（attach 后）", () => {
  it("写入直接转发 ScrollRegion.writeScrollLine 字节流", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    out.buffer = "";
    sc.writeScrollLine("hello");
    expect(out.buffer).toContain("hello\n");
  });

  it("空字符串 writeScrollLine 写一空行", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    out.buffer = "";
    sc.writeScrollLine("");
    expect(out.buffer).toMatch(/\n/);
  });

  it("writeScrollLine 后 cursor 跳回 input 位置", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"], 0, 0));
    out.buffer = "";
    sc.writeScrollLine("hi");
    // 期待末尾有 cursor positioning 到 input cursor (row 10 col 1)
    expect(out.buffer).toContain("\x1b[10;1H");
  });
});

describe("ScreenController · withScrollWrite（attach 后）", () => {
  it("流式 chunk 直接转发 ScrollRegion.appendInline", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    out.buffer = "";
    sc.withScrollWrite((write) => write("chunk"));
    expect(out.buffer).toContain("chunk");
  });

  it("空 chunk 不触发任何写入", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    out.buffer = "";
    sc.withScrollWrite(() => {});
    expect(out.buffer).toBe("");
  });

  it("多次 withScrollWrite 依次累积到 region 末尾", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    out.buffer = "";
    sc.withScrollWrite((write) => write("a"));
    sc.withScrollWrite((write) => write("b"));
    expect(out.buffer.indexOf("a")).toBeLessThan(out.buffer.indexOf("b"));
  });
});

describe("ScreenController · requestInputRepaint", () => {
  it("attach 后调用触发 chrome 协议", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    out.buffer = "";
    sc.requestInputRepaint();
    // setChromeHeight 同高度路径 emit chromeBytes + cursor 回 region
    expect(out.buffer).toContain("> input");
  });

  it("pre-attach 期间 requestInputRepaint 是 no-op", () => {
    const { out, sc } = makeHarness();
    sc.requestInputRepaint();
    expect(out.buffer).toBe("");
  });
});

describe("ScreenController · detachInput", () => {
  it("attach 后 detach 撤 DECSTBM + 擦 chrome", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    out.buffer = "";
    sc.detachInput();
    expect(out.buffer).toContain("\x1b[r"); // 撤 DECSTBM
  });

  it("pre-attach 时 detachInput 是 no-op", () => {
    const { out, sc } = makeHarness();
    sc.detachInput();
    expect(out.buffer).toBe("");
  });

  it("detach → 重新 attach 走完整启动流程（再次清 scrollback + 清 viewport）", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> a"]));
    sc.detachInput();
    out.buffer = "";
    sc.attachInput(makeRegion(["> b"]));
    // detach 让 ScrollRegion.attached=false，下次 attachInput 仍走 firstAttach → 再次启动序列
    expect(out.buffer).toContain("\x1b[2J\x1b[3J\x1b[1;1H");
    expect(out.buffer).toContain("> b");
  });
});

describe("ScreenController · ReplaceableSegment（双态渲染）", () => {
  it("begin 同步返回 handle、replace 后内容写入 region", () => {
    const { out, sc } = makeHarness({ rows: 20 });
    sc.attachInput(makeRegion(["> input"]));
    out.buffer = "";
    const h = sc.beginReplaceableSegment();
    h.replace("seg-text");
    expect(out.buffer).toContain("seg-text");
  });

  it("commit 替换内容并关闭——后续 replace no-op", () => {
    const { out, sc } = makeHarness({ rows: 20 });
    sc.attachInput(makeRegion(["> input"]));
    const h = sc.beginReplaceableSegment();
    h.commit("final");
    out.buffer = "";
    h.replace("ignored");
    expect(out.buffer).toBe("");
  });

  it("close 不替换、关闭 handle", () => {
    const { out, sc } = makeHarness({ rows: 20 });
    sc.attachInput(makeRegion(["> input"]));
    const h = sc.beginReplaceableSegment();
    h.close();
    out.buffer = "";
    h.replace("ignored");
    expect(out.buffer).toBe("");
  });

  it("活跃 segment 时再 begin 抛错（单一约束）", () => {
    const { sc } = makeHarness({ rows: 20 });
    sc.attachInput(makeRegion(["> input"]));
    sc.beginReplaceableSegment();
    expect(() => sc.beginReplaceableSegment()).toThrow(/active segment/);
  });

  it("commit 后可立即再次 begin（同步翻转 hasActiveSegment）", () => {
    const { sc } = makeHarness({ rows: 20 });
    sc.attachInput(makeRegion(["> input"]));
    const h1 = sc.beginReplaceableSegment();
    h1.commit("x");
    expect(() => sc.beginReplaceableSegment()).not.toThrow();
  });

  it("close 后可立即再次 begin", () => {
    const { sc } = makeHarness({ rows: 20 });
    sc.attachInput(makeRegion(["> input"]));
    const h1 = sc.beginReplaceableSegment();
    h1.close();
    expect(() => sc.beginReplaceableSegment()).not.toThrow();
  });

  it("disposed 状态 begin 抛错", () => {
    const { sc } = makeHarness({ rows: 20 });
    sc.dispose();
    expect(() => sc.beginReplaceableSegment()).toThrow(/dispose/);
  });

  it("pre-attach 期间 begin 抛错（fail-fast：caller 必须先 attachInput）", () => {
    const { sc } = makeHarness({ rows: 20 });
    expect(() => sc.beginReplaceableSegment()).toThrow(
      /attachInput first/,
    );
  });

  it("suspended 期间 begin 抛错（避免与 alt UI 并发）", () => {
    const { sc } = makeHarness({ rows: 20 });
    sc.attachInput(makeRegion(["> input"]));
    sc.suspend();
    expect(() => sc.beginReplaceableSegment()).toThrow(/suspended/);
  });

  it("detach 后 begin 抛错（attached=false 触发 fail-fast）", () => {
    const { sc } = makeHarness({ rows: 20 });
    sc.attachInput(makeRegion(["> input"]));
    sc.detachInput();
    expect(() => sc.beginReplaceableSegment()).toThrow(
      /attachInput first/,
    );
  });

  it("多次 replace 用最新内容覆盖", () => {
    const { out, sc } = makeHarness({ rows: 20 });
    sc.attachInput(makeRegion(["> input"]));
    const h = sc.beginReplaceableSegment();
    h.replace("v1");
    h.replace("v2");
    h.replace("v3");
    expect(out.buffer).toContain("v3");
  });
});

describe("ScreenController · suspend / resume", () => {
  it("suspend 同步清 region + cursor 跳 (1,1)——不入队", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    out.buffer = "";
    sc.suspend();
    // chrome=1（仅 input）→ scrollBottom=9，清 row 1..9 + cursor (1,1)
    expect(out.buffer).toContain("\x1b[9;1H\x1b[2K"); // 清最后一行 region
    expect(out.buffer).toContain("\x1b[1;1H"); // cursor 收尾
  });

  it("suspend 期间 enqueue 任务不立即生效——等 resume 才 flush", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.suspend();
    out.buffer = "";
    sc.writeScrollLine("queued");
    // suspended 期任务暂存
    expect(out.buffer).toBe("");
    sc.resume();
    // resume 后 flush——但 ScrollRegion 也走 resume 路径重设 DECSTBM
    expect(out.buffer).toContain("\x1b[1;9r");
    // 暂存的写入实际写到 region——不能因 ScrollRegion 仍 suspended 导致
    // requireWritable 抛错被静默吞掉（状态机镜像对必须同步翻转的契约）
    expect(out.buffer).toContain("queued");
  });

  it("suspend 期间 enqueue setStatusBar 在 resume 后实际生效", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.suspend();
    out.buffer = "";
    sc.setStatusBar(["S"]);
    expect(out.buffer).toBe(""); // 暂存
    sc.resume();
    expect(out.buffer).toContain("S"); // status 内容真实落到 chrome 区
  });

  it("suspend 期 begin 抛错——而暂存写入在 resume 后正确消费（验证状态机对称性）", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.suspend();
    out.buffer = "";
    // 多个暂存任务按 FIFO 在 resume 后依次消费
    sc.writeScrollLine("a");
    sc.writeScrollLine("b");
    sc.writeScrollLine("c");
    sc.resume();
    const aIdx = out.buffer.indexOf("a");
    const bIdx = out.buffer.indexOf("b");
    const cIdx = out.buffer.indexOf("c");
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(cIdx).toBeGreaterThan(bIdx);
  });

  it("suspend 重入抛错——不可嵌套", () => {
    const { sc } = makeHarness();
    sc.attachInput(makeRegion(["> input"]));
    sc.suspend();
    expect(() => sc.suspend()).toThrow(/already suspended/);
  });

  it("resume 未 suspend 时抛错——必须 suspend / resume 成对", () => {
    const { sc } = makeHarness();
    expect(() => sc.resume()).toThrow(/without prior suspend/);
  });

  it("dispose 后 suspend / resume 抛错", () => {
    const { sc } = makeHarness();
    sc.dispose();
    expect(() => sc.suspend()).toThrow(/dispose/);
    expect(() => sc.resume()).toThrow(/dispose/);
  });

  it("dispose 时 suspended → cleanup 仍执行（dispose 是特权清理）", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.suspend();
    out.buffer = "";
    sc.dispose();
    // dispose 强制清 suspended，flush 消费 cleanup（撤 DECSTBM）
    expect(out.buffer).toContain("\x1b[r");
  });
});

describe("ScreenController · onSuspendChange", () => {
  it("订阅时不立即触发——仅状态翻转时通知", () => {
    const { sc } = makeHarness();
    sc.attachInput(makeRegion(["> input"]));
    const events: boolean[] = [];
    sc.onSuspendChange((s) => events.push(s));
    expect(events).toEqual([]);
    sc.suspend();
    expect(events).toEqual([true]);
    sc.resume();
    expect(events).toEqual([true, false]);
  });

  it("unsubscribe 后不再接收通知", () => {
    const { sc } = makeHarness();
    sc.attachInput(makeRegion(["> input"]));
    const events: boolean[] = [];
    const off = sc.onSuspendChange((s) => events.push(s));
    off();
    sc.suspend();
    expect(events).toEqual([]);
  });

  it("监听器异常不影响其它监听器与 ScreenController", () => {
    const { sc } = makeHarness();
    sc.attachInput(makeRegion(["> input"]));
    const events: boolean[] = [];
    sc.onSuspendChange(() => {
      throw new Error("boom");
    });
    sc.onSuspendChange((s) => events.push(s));
    expect(() => sc.suspend()).not.toThrow();
    expect(events).toEqual([true]);
  });
});

describe("ScreenController · resize 监听", () => {
  it("emit resize 触发 ScrollRegion.handleResize", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    out.buffer = "";
    out.rows = 20;
    out.columns = 100;
    out.emit("resize");
    // handleResize 重设 DECSTBM 1..(rows-chromeHeight) = 1..19
    expect(out.buffer).toContain("\x1b[1;19r");
  });

  it("resize 后 chrome 字节用新 scrollBottom 定位 cursor positioning（避免写错位置）", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    // 初始 chrome 在 row 10（scrollBottom=9, chrome 起手 row 10）
    out.buffer = "";
    out.rows = 30;
    out.columns = 100;
    out.emit("resize");
    // 新 scrollBottom = 30 - 1 = 29，chrome 起手 row 30
    // chromeBytes 内 cursor positioning 应该是 \x1b[30;1H 而非旧的 \x1b[10;1H
    expect(out.buffer).toContain("\x1b[30;1H");
    expect(out.buffer).not.toContain("\x1b[10;1H\x1b[2K> input");
  });

  it("resize 后 setStatusBar 用新 viewport 算 scrollBottom（chrome 协议持续正确）", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    out.rows = 30;
    out.emit("resize");
    out.buffer = "";
    sc.setStatusBar(["S"]);
    // 新 chrome = 1 status + 1 input = 2，新 scrollBottom = 30-2 = 28
    // setChromeHeight 重设 DECSTBM 1..28
    expect(out.buffer).toContain("\x1b[1;28r");
    // chrome 起手 row 29
    expect(out.buffer).toContain("\x1b[29;1H");
  });

  it("resize 时 input.renderLines() 因 columns 变化触发 reflow 行数变化——DECSTBM 与 chrome 起手行同步对齐", () => {
    // Finding 1 端到端回归覆盖：caller 端 chromeHeight 与 ScrollRegion 内部
    // chromeHeight 必须用同一值推导 scrollBottom，否则 chrome 第一行落到 region
    // 末，下次写 region 推走 chrome（chrome 永驻协议失守）。
    const out = new FakeStdout();
    out.rows = 20;
    out.columns = 80;
    let dynamicLines: readonly string[] = ["> input"];
    const region: InputRegion = {
      renderLines: () => dynamicLines,
      cursorPosition: () => ({ row: 0, col: 0 }),
    };
    const sc = createScreenController({
      capability: makeCapability(20, 80),
      stdout: out as unknown as NodeJS.WriteStream,
    });
    sc.attachInput(region);
    // 初始 chromeHeight=1, scrollBottom=19

    // 模拟 columns 80→40 导致 input box reflow 多 1 行
    out.rows = 20;
    out.columns = 40;
    dynamicLines = ["> input head", "  cont"];
    out.buffer = "";
    out.emit("resize");

    // 新 chromeHeight=2, 新 scrollBottom = 20 - 2 = 18
    expect(out.buffer).toContain("\x1b[1;18r"); // DECSTBM 用新 chromeHeight
    expect(out.buffer).toContain("\x1b[19;1H"); // chrome 起手 row = scrollBottom + 1 = 19
    // 关键反向断言：旧 chromeHeight=1 算的 DECSTBM 必须不出现
    expect(out.buffer).not.toContain("\x1b[1;19r");
    // chrome 内容真实写出
    expect(out.buffer).toContain("> input head");
    expect(out.buffer).toContain("  cont");
  });

  it("dispose 解绑 resize listener——不再响应 emit", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.dispose();
    out.buffer = "";
    out.emit("resize");
    expect(out.buffer).toBe("");
  });

  it("pre-attach 期间 resize 是 no-op", () => {
    const { out } = makeHarness();
    // 不 attach
    out.emit("resize");
    expect(out.buffer).toBe("");
  });
});

describe("ScreenController · dispose", () => {
  it("attached=true dispose：shutdown 完整退出序列（撤 DECSTBM + 整屏清 + cursor）", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    out.buffer = "";
    sc.dispose();
    expect(out.buffer).toContain("\x1b[r"); // 撤 DECSTBM
    expect(out.buffer).toContain("\x1b[2J"); // 整屏清
    expect(out.buffer).toContain("\x1b[1;1H"); // cursor 回顶
  });

  it("detached(after detachInput) dispose：ScreenController 层补完整退出序列", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.detachInput();
    out.buffer = "";
    sc.dispose();
    // detachInput 已撤 DECSTBM + 清 chrome 几行，但 viewport 顶 region 内容仍残留
    // dispose 补完整序列：撤 DECSTBM（idempotent）+ 整屏清 + cursor
    expect(out.buffer).toContain("\x1b[r\x1b[2J\x1b[1;1H");
  });

  it("dispose 后 attach 不再产生输出", () => {
    const { out, sc } = makeHarness();
    sc.dispose();
    out.buffer = "";
    sc.attachInput(makeRegion(["> input"]));
    expect(out.buffer).toBe("");
  });

  it("重复 dispose 是 no-op", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.dispose();
    out.buffer = "";
    sc.dispose();
    expect(out.buffer).toBe("");
  });

  it("pre-attach dispose 不写字节（保护 shell 原状）", () => {
    const { out, sc } = makeHarness();
    sc.dispose();
    // 从未 attach → everAttached=false → 不写任何字节
    expect(out.buffer).toBe("");
  });
});

describe("ScreenController · setFarewell", () => {
  it("attached=true dispose：farewell emit 在清屏序列之后", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.setFarewell("BYE-TEXT\n");
    out.buffer = "";
    sc.dispose();
    // 清屏序列在前，farewell 在后
    const clearIdx = out.buffer.indexOf("\x1b[2J");
    const farewellIdx = out.buffer.indexOf("BYE-TEXT");
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(farewellIdx).toBeGreaterThan(clearIdx);
  });

  it("detached(after detachInput) dispose：farewell 仍 emit", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.detachInput();
    sc.setFarewell("BYE-TEXT\n");
    out.buffer = "";
    sc.dispose();
    expect(out.buffer).toContain("BYE-TEXT");
    // farewell 必须在 ANSI_DISPOSE_SEQUENCE 之后
    expect(out.buffer.indexOf("BYE-TEXT")).toBeGreaterThan(
      out.buffer.indexOf("\x1b[r"),
    );
  });

  it("pre-attach dispose：即使 setFarewell 也不 emit（保护 shell 原状）", () => {
    const { out, sc } = makeHarness();
    sc.setFarewell("BYE-TEXT\n");
    sc.dispose();
    // everAttached=false → 不 emit farewell（与不写任何字节原则一致）
    expect(out.buffer).toBe("");
  });

  it("未调 setFarewell 时 dispose 不 emit 告别内容", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    out.buffer = "";
    sc.dispose();
    // 只有清屏序列，没有额外文本
    // 清屏序列 = \x1b[r\x1b[2J\x1b[1;1H，长度有限
    expect(out.buffer).toContain("\x1b[r");
    expect(out.buffer).toContain("\x1b[2J");
    // 不应包含中文或其他可见 ASCII 文本
    expect(out.buffer).not.toMatch(/[a-zA-Z]{4,}/); // 任何 4+ 字母连续就算异常
  });

  it("setFarewell(null) 清除已设置的告别块", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.setFarewell("BYE-TEXT\n");
    sc.setFarewell(null);
    out.buffer = "";
    sc.dispose();
    expect(out.buffer).not.toContain("BYE-TEXT");
  });

  it("多次 setFarewell 以最后一次为准", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.setFarewell("FIRST\n");
    sc.setFarewell("SECOND\n");
    out.buffer = "";
    sc.dispose();
    expect(out.buffer).toContain("SECOND");
    expect(out.buffer).not.toContain("FIRST");
  });

  it("setFarewell 同步设值不触发立即写屏", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    out.buffer = "";
    sc.setFarewell("SHOULD-NOT-APPEAR-YET\n");
    // 设值后不应立即 emit
    expect(out.buffer).not.toContain("SHOULD-NOT-APPEAR-YET");
  });

  it("dispose 后 setFarewell 不再写入 dead state（与其他 setter 一致）", () => {
    const { out, sc } = makeHarness({ rows: 10 });
    sc.attachInput(makeRegion(["> input"]));
    sc.setFarewell("FIRST\n");
    sc.dispose();
    // dispose 后再 set，不应被记录（farewell 字段已归零，set 不能复活）
    sc.setFarewell("AFTER-DISPOSE\n");
    out.buffer = "";
    sc.dispose(); // 第二次 dispose 短路 no-op，但即使 emit 也不能含 dead text
    expect(out.buffer).not.toContain("AFTER-DISPOSE");
  });
});

describe("ScreenController · 串行化", () => {
  it("嵌套 enqueue（写入回调内调 setStatusBar）按 FIFO 顺序执行", () => {
    const { out, sc } = makeHarness({ rows: 20 });
    sc.attachInput(makeRegion(["> input"]));
    out.buffer = "";
    sc.withScrollWrite((write) => {
      write("a");
      sc.setStatusBar(["S"]);
    });
    // a 写在前 + status 在后；当前 task 完成后才执行 setStatusBar task
    const aIdx = out.buffer.indexOf("a");
    const sIdx = out.buffer.indexOf("S");
    expect(aIdx).toBeGreaterThan(-1);
    expect(sIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeLessThan(sIdx);
  });

  it("attach 之前 + 之后写入顺序保持", () => {
    const { out, sc } = makeHarness({ rows: 20 });
    sc.writeScrollLine("pre1");
    sc.writeScrollLine("pre2");
    sc.attachInput(makeRegion(["> input"]));
    sc.writeScrollLine("post1");
    // pre 走缓冲 → flush 时一次写出；post1 在 attach 之后实时写
    expect(out.buffer.indexOf("pre1")).toBeLessThan(out.buffer.indexOf("pre2"));
    expect(out.buffer.indexOf("pre2")).toBeLessThan(out.buffer.indexOf("post1"));
  });
});
