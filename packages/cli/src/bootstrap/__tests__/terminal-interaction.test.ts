/**
 * 终端字符状态机测试。
 *
 * processInputChar 是 read loop 的纯函数核心——所有字符路径在此覆盖：
 *   - 普通可见字符：累积到 buffer + echo（silent 时不 echo）
 *   - Backspace：删 buffer 最后 codePoint + 退格 echo（silent 时不 echo）
 *   - Enter：trim 后空 → cancel；非空 → submit
 *   - Ctrl+C：cancel
 *   - Ctrl+D：空 buffer cancel；非空 buffer 忽略
 *   - 其它控制字符：忽略
 *
 * 不测：terminal 集成层（readLine + setRawMode + stream wiring）——
 * 那部分由 M6 集成时手动 cmd / PowerShell 验证。
 */

import { describe, expect, it } from "vitest";
import {
  processAnsiSequenceChar,
  processInputChar,
  type AnsiSequenceState,
  type CharAction,
} from "../terminal-interaction.js";

// 便捷断言
function assertContinue(action: CharAction, expectedBuffer: string, expectedEcho: string): void {
  expect(action.kind).toBe("continue");
  if (action.kind === "continue") {
    expect(action.buffer).toBe(expectedBuffer);
    expect(action.echo).toBe(expectedEcho);
  }
}

describe("processInputChar · 普通字符", () => {
  it("ASCII 字符累积到 buffer，非 silent 时 echo 自身", () => {
    assertContinue(processInputChar("a", "", false), "a", "a");
    assertContinue(processInputChar("b", "a", false), "ab", "b");
  });

  it("ASCII 字符 silent 时累积但不 echo", () => {
    assertContinue(processInputChar("a", "", true), "a", "");
    assertContinue(processInputChar("k", "s", true), "sk", "");
  });

  it("CJK 字符按 codePoint 累积，非 silent 时 echo 字符本身", () => {
    // 单一 codePoint（BMP 内）
    assertContinue(processInputChar("中", "", false), "中", "中");
    assertContinue(processInputChar("文", "中", false), "中文", "文");
  });

  it("非 silent 时空格也 echo", () => {
    assertContinue(processInputChar(" ", "abc", false), "abc ", " ");
  });
});

describe("processInputChar · Backspace", () => {
  it("DEL (0x7F) 删 buffer 末尾，非 silent 时 echo 退格序列", () => {
    assertContinue(processInputChar("\x7f", "abc", false), "ab", "\b \b");
  });

  it("BS (0x08) 删 buffer 末尾，行为同 DEL", () => {
    assertContinue(processInputChar("\x08", "abc", false), "ab", "\b \b");
  });

  it("Backspace silent 时仍删 buffer 但不 echo", () => {
    assertContinue(processInputChar("\x7f", "abc", true), "ab", "");
  });

  it("空 buffer 时 Backspace 无效（buffer 不变，echo 为空）", () => {
    assertContinue(processInputChar("\x7f", "", false), "", "");
    assertContinue(processInputChar("\x7f", "", true), "", "");
  });

  it("Backspace 按 codePoint 删除：CJK 字符整字删除", () => {
    // 中文是 1 codePoint，不应该被半字符删除
    assertContinue(processInputChar("\x7f", "中文", false), "中", "\b \b");
  });
});

describe("processInputChar · Enter 提交", () => {
  it("非空 buffer + Enter (\\r) → submit", () => {
    const action = processInputChar("\r", "siliconflow", false);
    expect(action).toEqual({ kind: "submit", value: "siliconflow" });
  });

  it("非空 buffer + Enter (\\n) → submit", () => {
    const action = processInputChar("\n", "deepseek", false);
    expect(action).toEqual({ kind: "submit", value: "deepseek" });
  });

  it("空 buffer + Enter → cancel（用户主动空回车）", () => {
    expect(processInputChar("\r", "", false)).toEqual({ kind: "cancel" });
    expect(processInputChar("\n", "", true)).toEqual({ kind: "cancel" });
  });

  it("仅含空白 buffer + Enter → cancel（trim 后为空）", () => {
    expect(processInputChar("\r", "   ", false)).toEqual({ kind: "cancel" });
  });

  it("Enter 提交时 trim 前后空白", () => {
    const action = processInputChar("\r", "  sk-test  ", false);
    expect(action).toEqual({ kind: "submit", value: "sk-test" });
  });
});

describe("processInputChar · Ctrl+C", () => {
  it("Ctrl+C (0x03) 在任何 buffer 状态都 cancel", () => {
    expect(processInputChar("\x03", "", false)).toEqual({ kind: "cancel" });
    expect(processInputChar("\x03", "abc", false)).toEqual({ kind: "cancel" });
    expect(processInputChar("\x03", "abc", true)).toEqual({ kind: "cancel" });
  });
});

describe("processInputChar · Ctrl+D", () => {
  it("Ctrl+D (0x04) 在空 buffer 时 cancel", () => {
    expect(processInputChar("\x04", "", false)).toEqual({ kind: "cancel" });
    expect(processInputChar("\x04", "", true)).toEqual({ kind: "cancel" });
  });

  it("Ctrl+D 在非空 buffer 时忽略（不影响 buffer）", () => {
    assertContinue(processInputChar("\x04", "abc", false), "abc", "");
    assertContinue(processInputChar("\x04", "abc", true), "abc", "");
  });
});

describe("processInputChar · 其它控制字符", () => {
  it("Tab (0x09) 忽略", () => {
    assertContinue(processInputChar("\t", "abc", false), "abc", "");
  });

  it("Esc (0x1B) 忽略", () => {
    assertContinue(processInputChar("\x1b", "abc", false), "abc", "");
  });

  it("Bell (0x07) 忽略", () => {
    assertContinue(processInputChar("\x07", "abc", false), "abc", "");
  });

  it("控制字符不破坏 buffer", () => {
    // 模拟用户连续输入：a + Tab + b → buffer 应该是 "ab"（Tab 被吞）
    let buf = "";
    let action = processInputChar("a", buf, false);
    if (action.kind === "continue") buf = action.buffer;
    action = processInputChar("\t", buf, false);
    if (action.kind === "continue") buf = action.buffer;
    action = processInputChar("b", buf, false);
    if (action.kind === "continue") buf = action.buffer;
    expect(buf).toBe("ab");
  });
});

describe("processInputChar · silent / 非 silent 行为对照", () => {
  it("buffer 状态推进与 silent 无关——只影响 echo", () => {
    const nonSilent = processInputChar("a", "", false);
    const silent = processInputChar("a", "", true);

    // 同样输入"a" + 空 buffer
    if (nonSilent.kind === "continue" && silent.kind === "continue") {
      expect(nonSilent.buffer).toBe(silent.buffer);
      expect(nonSilent.echo).not.toBe(silent.echo);
      expect(silent.echo).toBe("");
    } else {
      throw new Error("expected continue actions");
    }
  });

  it("Backspace 的 buffer 删除与 silent 无关", () => {
    const nonSilent = processInputChar("\x7f", "abc", false);
    const silent = processInputChar("\x7f", "abc", true);

    if (nonSilent.kind === "continue" && silent.kind === "continue") {
      expect(nonSilent.buffer).toBe(silent.buffer);
      expect(nonSilent.buffer).toBe("ab");
    } else {
      throw new Error("expected continue actions");
    }
  });

  it("Enter / Ctrl+C / Ctrl+D 的判定与 silent 无关", () => {
    expect(processInputChar("\r", "test", false)).toEqual({ kind: "submit", value: "test" });
    expect(processInputChar("\r", "test", true)).toEqual({ kind: "submit", value: "test" });

    expect(processInputChar("\x03", "anything", false)).toEqual({ kind: "cancel" });
    expect(processInputChar("\x03", "anything", true)).toEqual({ kind: "cancel" });
  });
});

describe("processInputChar · 完整输入序列模拟", () => {
  it("输入 'sk-test' → Backspace → 't' → Enter → submit 'sk-tes' + 't' = 'sk-test'", () => {
    let buf = "";
    const sequence = ["s", "k", "-", "t", "e", "s", "t"];

    for (const ch of sequence) {
      const action = processInputChar(ch, buf, true);
      if (action.kind === "continue") buf = action.buffer;
    }
    expect(buf).toBe("sk-test");

    // 退格删 't'
    const back = processInputChar("\x7f", buf, true);
    if (back.kind === "continue") buf = back.buffer;
    expect(buf).toBe("sk-tes");

    // 重补 't'
    const add = processInputChar("t", buf, true);
    if (add.kind === "continue") buf = add.buffer;
    expect(buf).toBe("sk-test");

    // 提交
    const submit = processInputChar("\r", buf, true);
    expect(submit).toEqual({ kind: "submit", value: "sk-test" });
  });
});

// ─── ANSI 序列状态机测试 ───

describe("processAnsiSequenceChar · 状态转移", () => {
  it("none + ESC → esc 状态，吞 ESC", () => {
    expect(processAnsiSequenceChar("\x1b", "none")).toEqual({
      newState: "esc",
      passThrough: false,
    });
  });

  it("none + 普通字符 → none 状态，pass-through", () => {
    expect(processAnsiSequenceChar("a", "none")).toEqual({
      newState: "none",
      passThrough: true,
    });
    expect(processAnsiSequenceChar("中", "none")).toEqual({
      newState: "none",
      passThrough: true,
    });
  });

  it("esc + '[' → csi 状态，吞 [", () => {
    expect(processAnsiSequenceChar("[", "esc")).toEqual({
      newState: "csi",
      passThrough: false,
    });
  });

  it("esc + 非 [ → none 状态，pass-through（孤立 ESC 丢，当前字符正常）", () => {
    expect(processAnsiSequenceChar("a", "esc")).toEqual({
      newState: "none",
      passThrough: true,
    });
    expect(processAnsiSequenceChar("\r", "esc")).toEqual({
      newState: "none",
      passThrough: true,
    });
  });

  it("csi + 终结字符 (0x40-0x7E) → none 状态，吞终结字符", () => {
    // 'A' = 0x41, 'Z' = 0x5A, '~' = 0x7E
    expect(processAnsiSequenceChar("A", "csi")).toEqual({
      newState: "none",
      passThrough: false,
    });
    expect(processAnsiSequenceChar("~", "csi")).toEqual({
      newState: "none",
      passThrough: false,
    });
    expect(processAnsiSequenceChar("@", "csi")).toEqual({
      newState: "none",
      passThrough: false,
    });
  });

  it("csi + 参数字符 (0x20-0x3F) → csi 状态，吞字符", () => {
    expect(processAnsiSequenceChar("1", "csi")).toEqual({
      newState: "csi",
      passThrough: false,
    });
    expect(processAnsiSequenceChar(";", "csi")).toEqual({
      newState: "csi",
      passThrough: false,
    });
    expect(processAnsiSequenceChar("?", "csi")).toEqual({
      newState: "csi",
      passThrough: false,
    });
  });
});

describe("processAnsiSequenceChar · 用户逃生口（CSI 异常字符 abort）", () => {
  // 关键不变量：用户的"逃生键"（Ctrl+C / Enter / Backspace 等）在任何 ANSI 状态下
  // 都不能被吞掉——必须 abort 当前序列并 pass-through 给字符级状态机。
  // 否则用户在罕见的 CSI 卡死场景下（如粘贴未完成 sequence）只能 kill 进程。

  it("csi + Ctrl+C (0x03) → abort，Ctrl+C pass-through 让 char-level 取消", () => {
    expect(processAnsiSequenceChar("\x03", "csi")).toEqual({
      newState: "none",
      passThrough: true,
    });
  });

  it("csi + Enter (\\r / \\n) → abort + pass-through 让用户提交", () => {
    expect(processAnsiSequenceChar("\r", "csi")).toEqual({
      newState: "none",
      passThrough: true,
    });
    expect(processAnsiSequenceChar("\n", "csi")).toEqual({
      newState: "none",
      passThrough: true,
    });
  });

  it("csi + Backspace (DEL 0x7F / BS 0x08) → abort + pass-through 让用户删除", () => {
    expect(processAnsiSequenceChar("\x7f", "csi")).toEqual({
      newState: "none",
      passThrough: true,
    });
    expect(processAnsiSequenceChar("\x08", "csi")).toEqual({
      newState: "none",
      passThrough: true,
    });
  });

  it("csi + Ctrl+D (0x04) → abort + pass-through 让用户取消", () => {
    expect(processAnsiSequenceChar("\x04", "csi")).toEqual({
      newState: "none",
      passThrough: true,
    });
  });

  it("csi + 其它低位控制字符（Tab 0x09 等）→ abort + pass-through", () => {
    expect(processAnsiSequenceChar("\x09", "csi")).toEqual({
      newState: "none",
      passThrough: true,
    });
    expect(processAnsiSequenceChar("\x07", "csi")).toEqual({
      newState: "none",
      passThrough: true,
    });
  });

  it("csi + 高位字符 (>= 0x80, 含 CJK) → abort + pass-through", () => {
    // ANSI CSI 不接受 0x80+ 字符；遇到时 abort 让 char-level 正常处理（如累积到 buffer）
    expect(processAnsiSequenceChar("中", "csi")).toEqual({
      newState: "none",
      passThrough: true,
    });
  });
});

describe("processAnsiSequenceChar · 卡死场景的端到端逃生", () => {
  function traceSequence(
    sequence: string,
    initialState: AnsiSequenceState = "none",
  ): { passThroughFlags: boolean[]; finalState: AnsiSequenceState } {
    let state = initialState;
    const passThroughFlags: boolean[] = [];
    for (const ch of sequence) {
      const action = processAnsiSequenceChar(ch, state);
      state = action.newState;
      passThroughFlags.push(action.passThrough);
    }
    return { passThroughFlags, finalState: state };
  }

  it("粘贴未完成 CSI \\x1b[12 后按 Ctrl+C → 序列 abort，Ctrl+C 逃出", () => {
    // 用户从某来源粘贴 "\x1b[12" 然后按 Ctrl+C 想取消
    const { passThroughFlags, finalState } = traceSequence("\x1b[12\x03");

    // ESC=吞, [=吞, 1=吞(参数), 2=吞(参数), \x03=abort+pass-through
    expect(passThroughFlags).toEqual([false, false, false, false, true]);
    expect(finalState).toBe("none");
  });

  it("粘贴含分号参数的未完成 CSI 后按 Enter → 序列 abort，Enter 逃出", () => {
    const { passThroughFlags, finalState } = traceSequence("\x1b[1;2\r");

    // ESC=吞, [=吞, 1=吞, ;=吞, 2=吞, \r=abort+pass-through
    expect(passThroughFlags).toEqual([false, false, false, false, false, true]);
    expect(finalState).toBe("none");
  });

  it("CSI 内异常字符 abort 后，下一个 ESC 序列仍能正常识别", () => {
    // 验证 abort 后状态机彻底回到 none，不会因前一次损坏 sequence 影响后续
    let state: AnsiSequenceState = "none";

    // 第一段：损坏 sequence
    const corrupt = "\x1b[1\x03";
    for (const ch of corrupt) {
      state = processAnsiSequenceChar(ch, state).newState;
    }
    expect(state).toBe("none");

    // 第二段：正常方向键序列应被完整吞
    const arrow = traceSequence("\x1b[A", state);
    expect(arrow.passThroughFlags).toEqual([false, false, false]);
    expect(arrow.finalState).toBe("none");
  });
});

describe("processAnsiSequenceChar · 完整序列 trace", () => {
  function traceSequence(
    sequence: string,
    initialState: AnsiSequenceState = "none",
  ): { passThroughFlags: boolean[]; finalState: AnsiSequenceState } {
    let state = initialState;
    const passThroughFlags: boolean[] = [];
    for (const ch of sequence) {
      const action = processAnsiSequenceChar(ch, state);
      state = action.newState;
      passThroughFlags.push(action.passThrough);
    }
    return { passThroughFlags, finalState: state };
  }

  it("方向键 \\x1b[A 完整吞掉，回到 none 状态", () => {
    const { passThroughFlags, finalState } = traceSequence("\x1b[A");
    expect(passThroughFlags).toEqual([false, false, false]);
    expect(finalState).toBe("none");
  });

  it("F5 \\x1b[15~ 完整吞掉（带参数）", () => {
    const { passThroughFlags, finalState } = traceSequence("\x1b[15~");
    expect(passThroughFlags).toEqual([false, false, false, false, false]);
    expect(finalState).toBe("none");
  });

  it("Home / End \\x1b[H 与 \\x1b[F 完整吞掉", () => {
    expect(traceSequence("\x1b[H").passThroughFlags).toEqual([false, false, false]);
    expect(traceSequence("\x1b[F").passThroughFlags).toEqual([false, false, false]);
  });

  it("孤立 ESC + 普通字符 → ESC 吞，普通字符 pass-through", () => {
    const { passThroughFlags, finalState } = traceSequence("\x1ba");
    expect(passThroughFlags).toEqual([false, true]);
    expect(finalState).toBe("none");
  });

  it("正常字符流不受影响：'siliconflow' 全部 pass-through", () => {
    const { passThroughFlags, finalState } = traceSequence("siliconflow");
    expect(passThroughFlags).toEqual(Array(11).fill(true));
    expect(finalState).toBe("none");
  });

  it("方向键夹在普通字符之间：'a\\x1b[Bb' → 'a' + sequence 吞 + 'b' pass-through", () => {
    const { passThroughFlags, finalState } = traceSequence("a\x1b[Bb");
    // [a=true, ESC=false, [=false, B=false, b=true]
    expect(passThroughFlags).toEqual([true, false, false, false, true]);
    expect(finalState).toBe("none");
  });

  it("CSI 序列跨调用持续状态：分两次 chunk \\x1b[ + A → 完整吞", () => {
    const first = traceSequence("\x1b[");
    expect(first.passThroughFlags).toEqual([false, false]);
    expect(first.finalState).toBe("csi");

    const second = traceSequence("A", first.finalState);
    expect(second.passThroughFlags).toEqual([false]);
    expect(second.finalState).toBe("none");
  });
});
