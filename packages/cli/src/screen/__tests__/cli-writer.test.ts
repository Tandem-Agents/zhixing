import { describe, expect, it, vi } from "vitest";
import {
  createScreenWriter,
  createStdoutWriter,
  type CliWriter,
} from "../cli-writer.js";
import type { ScreenController } from "../screen-controller.js";

class FakeStdout {
  buffer = "";
  isTTY = true;
  columns = 80;
  write(s: string): boolean {
    this.buffer += s;
    return true;
  }
}

function makeFakeScreen(): ScreenController & {
  events: Array<{ kind: string; text?: string }>;
} {
  const events: Array<{ kind: string; text?: string }> = [];
  return {
    events,
    attachInput: () => {},
    detachInput: () => {},
    setStatusBar: () => {},
    requestInputRepaint: () => {},
    withScrollWrite(fn) {
      let collected = "";
      fn((c) => (collected += c));
      events.push({ kind: "withScrollWrite", text: collected });
    },
    notifyDeferred(text) {
      events.push({ kind: "notifyDeferred", text });
    },
    dispose: () => {},
  };
}

describe("ScreenWriter · 走 ScreenController 协调", () => {
  it("line 自动补 \\n（独立段语义）", () => {
    const screen = makeFakeScreen();
    const w = createScreenWriter({ screen });
    w.line("hello");
    expect(screen.events).toEqual([
      { kind: "withScrollWrite", text: "hello\n" },
    ]);
  });

  it("line 末尾已是 \\n 不重复补", () => {
    const screen = makeFakeScreen();
    const w = createScreenWriter({ screen });
    w.line("hello\n");
    expect(screen.events).toEqual([
      { kind: "withScrollWrite", text: "hello\n" },
    ]);
  });

  it("空 line 写一个 \\n（空行语义，让 frame buffer 加空行）", () => {
    const screen = makeFakeScreen();
    const w = createScreenWriter({ screen });
    w.line("");
    expect(screen.events).toEqual([
      { kind: "withScrollWrite", text: "\n" },
    ]);
  });

  it("appendInline 不补 \\n（流式接续）", () => {
    const screen = makeFakeScreen();
    const w = createScreenWriter({ screen });
    w.appendInline("hello");
    expect(screen.events).toEqual([
      { kind: "withScrollWrite", text: "hello" },
    ]);
  });

  it("空 appendInline 是 no-op（不写空字符到 frame buffer）", () => {
    const screen = makeFakeScreen();
    const w = createScreenWriter({ screen });
    w.appendInline("");
    expect(screen.events).toEqual([]);
  });

  it("多次 appendInline 在同一段接续——chunk 流式语义", () => {
    const screen = makeFakeScreen();
    const w = createScreenWriter({ screen });
    w.appendInline("你好");
    w.appendInline("世界");
    // 两次 withScrollWrite，每次内容不补 \n —— frame buffer 端拼接到末尾行
    expect(screen.events).toEqual([
      { kind: "withScrollWrite", text: "你好" },
      { kind: "withScrollWrite", text: "世界" },
    ]);
  });

  it("notify 走 notifyDeferred + 自动补 \\n（独立段语义，与 line 对称）", () => {
    const screen = makeFakeScreen();
    const w = createScreenWriter({ screen });
    w.notify("scheduler done");
    expect(screen.events).toEqual([
      { kind: "notifyDeferred", text: "scheduler done\n" },
    ]);
  });
});

describe("StdoutWriter · 直写 stdout（无协调）", () => {
  function makeStdoutWriter(): { writer: CliWriter; out: FakeStdout } {
    const out = new FakeStdout();
    const writer = createStdoutWriter({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    return { writer, out };
  }

  it("line 自动补 \\n 让每段独立落地", () => {
    const { writer, out } = makeStdoutWriter();
    writer.line("hello");
    expect(out.buffer).toBe("hello\n");
  });

  it("line 末尾已是 \\n 不重复补", () => {
    const { writer, out } = makeStdoutWriter();
    writer.line("hello\n");
    expect(out.buffer).toBe("hello\n");
  });

  it("空 line 写一个 \\n（空行）", () => {
    const { writer, out } = makeStdoutWriter();
    writer.line("");
    expect(out.buffer).toBe("\n");
  });

  it("appendInline 不补 \\n——LLM 流式 chunk 接续", () => {
    const { writer, out } = makeStdoutWriter();
    writer.appendInline("你好");
    writer.appendInline("世界");
    expect(out.buffer).toBe("你好世界");
  });

  it("空 appendInline 是 no-op", () => {
    const { writer, out } = makeStdoutWriter();
    writer.appendInline("");
    expect(out.buffer).toBe("");
  });

  it("notify 等同 line（自动补 \\n）", () => {
    const { writer, out } = makeStdoutWriter();
    writer.notify("scheduler done");
    expect(out.buffer).toBe("scheduler done\n");
  });

  it("混合用法：line 段落 + appendInline 流式 + 段间独立", () => {
    const { writer, out } = makeStdoutWriter();
    writer.line("段落 A");
    writer.appendInline("流");
    writer.appendInline("式");
    writer.appendInline("接续");
    writer.line(""); // 强制结束流式段，进入新行
    writer.line("段落 B");
    expect(out.buffer).toBe("段落 A\n流式接续\n段落 B\n");
  });
});

describe("CliWriter · 接口契约对称性", () => {
  it("ScreenWriter 与 StdoutWriter 都实现完整 CliWriter 接口", () => {
    const screen = makeFakeScreen();
    const sw: CliWriter = createScreenWriter({ screen });
    const stw: CliWriter = createStdoutWriter();
    for (const w of [sw, stw]) {
      expect(typeof w.line).toBe("function");
      expect(typeof w.appendInline).toBe("function");
      expect(typeof w.notify).toBe("function");
    }
  });
});

void vi;
