import { describe, expect, it, vi } from "vitest";
import {
  createScreenWriter,
  createStdoutWriter,
  type CliWriter,
} from "../cli-writer.js";
import type {
  ReplaceableSegmentHandle,
  ScreenController,
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

function makeFakeScreen(): ScreenController & {
  events: Array<{ kind: string; text?: string }>;
  segments: ReplaceableSegmentHandle[];
} {
  const events: Array<{ kind: string; text?: string }> = [];
  const segments: ReplaceableSegmentHandle[] = [];
  return {
    events,
    segments,
    attachInput: () => {},
    detachInput: () => {},
    setStatusBar: () => {},
    requestInputRepaint: () => {},
    withScrollWrite(fn) {
      let collected = "";
      fn((c) => (collected += c));
      events.push({ kind: "withScrollWrite", text: collected });
    },
    writeScrollLine(text) {
      events.push({ kind: "writeScrollLine", text });
    },
    ensureScrollLeadingBlank() {
      events.push({ kind: "ensureScrollLeadingBlank" });
    },
    beginReplaceableSegment() {
      const handle: ReplaceableSegmentHandle = {
        replace: (text) => events.push({ kind: "seg.replace", text }),
        commit: (text) => events.push({ kind: "seg.commit", text }),
        close: () => events.push({ kind: "seg.close" }),
      };
      segments.push(handle);
      events.push({ kind: "beginReplaceableSegment" });
      return handle;
    },
    suspend: () => {},
    resume: () => {},
    onSuspendChange: () => () => {},
    dispose: () => {},
  };
}

describe("ScreenWriter · 走 ScreenController 协调", () => {
  it("line 走 writeScrollLine（独立段语义，由 ScreenController 内部保证起新行 + 末尾 \\n）", () => {
    const screen = makeFakeScreen();
    const w = createScreenWriter({ screen });
    w.line("hello");
    expect(screen.events).toEqual([
      { kind: "writeScrollLine", text: "hello" },
    ]);
  });

  it("line 透传文本——不在 cliWriter 层加工，让 ScreenController 单一处理", () => {
    const screen = makeFakeScreen();
    const w = createScreenWriter({ screen });
    w.line("hello\n");
    expect(screen.events).toEqual([
      { kind: "writeScrollLine", text: "hello\n" },
    ]);
  });

  it("空 line 走 writeScrollLine 空字符串（空行语义由 ScreenController 内部处理）", () => {
    const screen = makeFakeScreen();
    const w = createScreenWriter({ screen });
    w.line("");
    expect(screen.events).toEqual([
      { kind: "writeScrollLine", text: "" },
    ]);
  });

  it("appendInline 走 withScrollWrite（流式接续）", () => {
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
    expect(screen.events).toEqual([
      { kind: "withScrollWrite", text: "你好" },
      { kind: "withScrollWrite", text: "世界" },
    ]);
  });

  it("notify 走 writeScrollLine（与 line 同语义，独立段保证不与流式 chunk 粘连）", () => {
    const screen = makeFakeScreen();
    const w = createScreenWriter({ screen });
    w.notify("scheduler done");
    expect(screen.events).toEqual([
      { kind: "writeScrollLine", text: "scheduler done" },
    ]);
  });

  it("空 notify 走 writeScrollLine 空字符串（与 line('') / StdoutWriter.notify('') 行为对称）", () => {
    const screen = makeFakeScreen();
    const w = createScreenWriter({ screen });
    w.notify("");
    expect(screen.events).toEqual([
      { kind: "writeScrollLine", text: "" },
    ]);
  });

  it("ensureSegmentBreak 转发 screen.ensureScrollLeadingBlank（chrome 模式段间幂等保证）", () => {
    const screen = makeFakeScreen();
    const w = createScreenWriter({ screen });
    w.ensureSegmentBreak();
    expect(screen.events).toEqual([
      { kind: "ensureScrollLeadingBlank" },
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

  describe("ensureSegmentBreak · stdout 模式 no-op（无 chrome 视觉协调职责）", () => {
    // 架构契约：StdoutWriter 用于 pipe / CI / log 场景——消费者关心稳定 stream
    // 格式（ndjson / awk 解析等），不需要也不应当被加入"段间视觉空行"。视觉
    // 间距由 ScreenWriter（chrome 模式）独家负责。

    it("ensureSegmentBreak 不写任何字节——pipe / CI 模式 stream 格式稳定", () => {
      const { writer, out } = makeStdoutWriter();
      writer.line("段 A");
      writer.ensureSegmentBreak();
      writer.line("段 B");
      // 无间距 emit——caller 调 ensureSegmentBreak 在 stdout 模式下静默
      expect(out.buffer).toBe("段 A\n段 B\n");
    });

    it("多次调 ensureSegmentBreak 仍 no-op（幂等成无操作）", () => {
      const { writer, out } = makeStdoutWriter();
      writer.ensureSegmentBreak();
      writer.ensureSegmentBreak();
      writer.ensureSegmentBreak();
      expect(out.buffer).toBe("");
    });

    it("mid-line appendInline 后 ensureSegmentBreak 也 no-op（不主动收口）", () => {
      const { writer, out } = makeStdoutWriter();
      writer.appendInline("接续中");
      writer.ensureSegmentBreak();
      writer.line("新段");
      // 接续中（无 \n） + 新段\n = "接续中新段\n" —— 收口由后续 line 自己保证
      expect(out.buffer).toBe("接续中新段\n");
    });
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
      expect(typeof w.ensureSegmentBreak).toBe("function");
    }
  });
});

describe("CliWriter · ReplaceableSegment optional 接口", () => {
  it("ScreenWriter.beginReplaceableSegment 转发到 ScreenController", () => {
    const screen = makeFakeScreen();
    const w = createScreenWriter({ screen });
    const handle = w.beginReplaceableSegment!();
    handle.replace("dim text");
    handle.commit("highlight text");
    expect(screen.events).toEqual([
      { kind: "beginReplaceableSegment" },
      { kind: "seg.replace", text: "dim text" },
      { kind: "seg.commit", text: "highlight text" },
    ]);
  });

  it("StdoutWriter 不实现 beginReplaceableSegment（caller 走 fallback hold）", () => {
    const stw = createStdoutWriter();
    expect(stw.beginReplaceableSegment).toBeUndefined();
  });

  it("caller optional chaining：ScreenWriter 返回 handle，StdoutWriter 返回 undefined", () => {
    const screen = makeFakeScreen();
    const sw = createScreenWriter({ screen });
    const stw = createStdoutWriter();
    const swHandle = sw.beginReplaceableSegment?.();
    const stwHandle = stw.beginReplaceableSegment?.();
    expect(swHandle).toBeDefined();
    expect(stwHandle).toBeUndefined();
  });
});

void vi;
