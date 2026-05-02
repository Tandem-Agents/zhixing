/**
 * KeyDecoder 测试——按键序列正确转换为 KeyEvent。
 *
 * 重点覆盖：
 *   - 普通字符：char event
 *   - 控制键：enter / backspace / escape / ctrl-c
 *   - ANSI 序列：方向键四向（ESC[A/B/C/D）
 *   - 跨 chunk 状态保持（CSI 序列被 chunk 切断）
 *   - 异常字符 abort（粘贴未完成 CSI 后用户按 Ctrl+C 仍生效）
 */

import { describe, expect, it } from "vitest";
import {
  createKeyDecoderState,
  decodeChar,
  decodeChunk,
} from "../ui/key-decoder.js";

describe("decodeChar · 单字符解码", () => {
  it("普通字符 → char event", () => {
    const result = decodeChar("a", createKeyDecoderState());
    expect(result.events).toEqual([{ type: "char", ch: "a" }]);
    expect(result.newState.ansi).toBe("none");
  });

  it("数字 / 标点都视为 char", () => {
    expect(decodeChar("5", createKeyDecoderState()).events).toEqual([
      { type: "char", ch: "5" },
    ]);
    expect(decodeChar("@", createKeyDecoderState()).events).toEqual([
      { type: "char", ch: "@" },
    ]);
  });

  it("\\r 触发 enter", () => {
    expect(decodeChar("\r", createKeyDecoderState()).events).toEqual([
      { type: "enter" },
    ]);
  });

  it("\\n 触发 enter", () => {
    expect(decodeChar("\n", createKeyDecoderState()).events).toEqual([
      { type: "enter" },
    ]);
  });

  it("\\r\\n 序列只产出一个 enter（CRLF 行尾归一）", () => {
    // 关键回归保护：粘贴场景。Windows 剪贴板 / CRLF 文本文件粘贴 API Key 时
    // chunk 含 \r\n；不归一会让 `sk-xxx\r\n` 触发双 enter，第二个跳错面板层级
    const result = decodeChunk("\r\n", createKeyDecoderState());
    expect(result.events).toEqual([{ type: "enter" }]);
  });

  it("\\r 后接非 \\n 字符 → \\r 单独 enter + 后字符正常处理", () => {
    const result = decodeChunk("\ra", createKeyDecoderState());
    expect(result.events).toEqual([
      { type: "enter" },
      { type: "char", ch: "a" },
    ]);
  });

  it("\\n 单独 → enter（非 CRLF 序列）", () => {
    expect(decodeChunk("\n", createKeyDecoderState()).events).toEqual([
      { type: "enter" },
    ]);
  });

  it("连续 \\r\\r\\n → 两个 enter（第一个 \\r 后立刻 \\r，第二个 \\r 后接 \\n 吞）", () => {
    const result = decodeChunk("\r\r\n", createKeyDecoderState());
    expect(result.events).toEqual([{ type: "enter" }, { type: "enter" }]);
  });

  it("\\r\\n\\r\\n（用户连按两次 Enter）→ 两个 enter", () => {
    const result = decodeChunk("\r\n\r\n", createKeyDecoderState());
    expect(result.events).toEqual([{ type: "enter" }, { type: "enter" }]);
  });

  it("跨 chunk 的 \\r\\n：第一 chunk 含 \\r，第二 chunk 含 \\n", () => {
    let state = createKeyDecoderState();
    let r = decodeChunk("\r", state);
    expect(r.events).toEqual([{ type: "enter" }]);
    state = r.newState;
    r = decodeChunk("\n", state);
    expect(r.events).toEqual([]);
  });

  it("Ctrl+C (0x03) 触发 ctrl-c", () => {
    expect(decodeChar("\x03", createKeyDecoderState()).events).toEqual([
      { type: "ctrl-c" },
    ]);
  });

  it("DEL (0x7F) 触发 backspace", () => {
    expect(decodeChar("\x7f", createKeyDecoderState()).events).toEqual([
      { type: "backspace" },
    ]);
  });

  it("BS (0x08) 触发 backspace", () => {
    expect(decodeChar("\x08", createKeyDecoderState()).events).toEqual([
      { type: "backspace" },
    ]);
  });

  it("其他 < 0x20 控制字符忽略（无 event）", () => {
    const result = decodeChar("\x01", createKeyDecoderState());
    expect(result.events).toEqual([]);
  });

  it("ESC 进入 ansi=esc 状态，无 event", () => {
    const result = decodeChar("\x1b", createKeyDecoderState());
    expect(result.events).toEqual([]);
    expect(result.newState.ansi).toBe("esc");
  });
});

describe("decodeChar · ANSI 序列识别", () => {
  it("ESC + [ 进入 csi 状态", () => {
    let state = createKeyDecoderState();
    state = decodeChar("\x1b", state).newState;
    state = decodeChar("[", state).newState;
    expect(state.ansi).toBe("csi");
  });

  it("ESC[A → arrow-up", () => {
    let state = createKeyDecoderState();
    const events: unknown[] = [];
    for (const ch of "\x1b[A") {
      const r = decodeChar(ch, state);
      state = r.newState;
      events.push(...r.events);
    }
    expect(events).toEqual([{ type: "arrow-up" }]);
  });

  it("ESC[B → arrow-down", () => {
    const result = decodeChunk("\x1b[B", createKeyDecoderState());
    expect(result.events).toEqual([{ type: "arrow-down" }]);
  });

  it("ESC[C → arrow-right", () => {
    expect(decodeChunk("\x1b[C", createKeyDecoderState()).events).toEqual([
      { type: "arrow-right" },
    ]);
  });

  it("ESC[D → arrow-left", () => {
    expect(decodeChunk("\x1b[D", createKeyDecoderState()).events).toEqual([
      { type: "arrow-left" },
    ]);
  });

  it("未识别的 CSI 序列吞掉无 event（如 ESC[H Home）", () => {
    expect(decodeChunk("\x1b[H", createKeyDecoderState()).events).toEqual([]);
  });

  it("含参数的 CSI（如 ESC[1;2A 修饰方向键）目前不识别", () => {
    // 复杂修饰按键不在编辑器交互范围，吞掉
    expect(decodeChunk("\x1b[1;2A", createKeyDecoderState()).events).toEqual([]);
  });

  it("孤立 ESC 后跟随非 [ → escape event + 该字符正常处理", () => {
    const result = decodeChunk("\x1ba", createKeyDecoderState());
    expect(result.events).toEqual([{ type: "escape" }, { type: "char", ch: "a" }]);
  });
});

describe("decodeChunk · 多字符流处理", () => {
  it("多字符序列：'abc'", () => {
    const result = decodeChunk("abc", createKeyDecoderState());
    expect(result.events).toEqual([
      { type: "char", ch: "a" },
      { type: "char", ch: "b" },
      { type: "char", ch: "c" },
    ]);
  });

  it("混合：字符 + ANSI 序列 + Enter", () => {
    const result = decodeChunk("a\x1b[B\r", createKeyDecoderState());
    expect(result.events).toEqual([
      { type: "char", ch: "a" },
      { type: "arrow-down" },
      { type: "enter" },
    ]);
  });

  it("跨 chunk 的 CSI 序列：第一个 chunk 含 ESC[，第二个含 A", () => {
    let state = createKeyDecoderState();
    let r = decodeChunk("\x1b[", state);
    expect(r.events).toEqual([]);
    state = r.newState;
    expect(state.ansi).toBe("csi");
    r = decodeChunk("A", state);
    expect(r.events).toEqual([{ type: "arrow-up" }]);
  });

  it("CSI 中遇到异常字符 abort + 该字符 pass-through", () => {
    // ESC[ 后接 \x03 (Ctrl+C) → CSI abort，Ctrl+C 触发 ctrl-c event
    const result = decodeChunk("\x1b[\x03", createKeyDecoderState());
    expect(result.events).toEqual([{ type: "ctrl-c" }]);
  });
});

describe("decodeChunk · 输入完整流", () => {
  it("用户输入 sk-test 然后 Enter", () => {
    const result = decodeChunk("sk-test\r", createKeyDecoderState());
    expect(result.events.map((e) => e.type)).toEqual([
      "char",
      "char",
      "char",
      "char",
      "char",
      "char",
      "char",
      "enter",
    ]);
  });

  it("用户向下移光标 3 次后 Enter", () => {
    const result = decodeChunk(
      "\x1b[B\x1b[B\x1b[B\r",
      createKeyDecoderState(),
    );
    expect(result.events).toEqual([
      { type: "arrow-down" },
      { type: "arrow-down" },
      { type: "arrow-down" },
      { type: "enter" },
    ]);
  });
});
