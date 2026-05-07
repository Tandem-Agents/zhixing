import { describe, expect, it } from "vitest";
import { createOutputRenderer } from "../output-renderer.js";
import { stripAnsi } from "../../tui/ansi.js";
import type { CliWriter } from "../../screen/index.js";

interface CapturedWriter extends CliWriter {
  buffer: string;
}

function makeCaptureWriter(): CapturedWriter {
  let buffer = "";
  return {
    get buffer() {
      return buffer;
    },
    line(text) {
      buffer += text;
      if (!text.endsWith("\n")) buffer += "\n";
    },
    appendInline(text) {
      buffer += text;
    },
    notify(text) {
      buffer += text;
      if (!text.endsWith("\n")) buffer += "\n";
    },
  } as CapturedWriter;
}

describe("createOutputRenderer · 派发型工具不渲染 ⟡ 卡片", () => {
  it("default 工具 (read) 正常渲染 ⟡ 卡片", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer });
    renderer.handleEvent({
      type: "tool_start",
      id: "tc1",
      name: "read",
      input: { path: "a.ts" },
    });
    const out = stripAnsi(writer.buffer);
    expect(out).toContain("⟡");
    expect(out).toContain("read");
    expect(out).toContain("a.ts");
  });

  it("Task 工具 tool_start → 主路径完全静默", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer });
    renderer.handleEvent({
      type: "tool_start",
      id: "tc1",
      name: "Task",
      input: { description: "x", prompt: "..." },
    });
    expect(writer.buffer).toBe("");
  });

  it("Task 工具 tool_end → 主路径完全静默", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer });
    renderer.handleEvent({
      type: "tool_end",
      id: "tc1",
      name: "Task",
      result: { content: "ok", isError: false },
      duration: 100,
    });
    expect(writer.buffer).toBe("");
  });

  it("default 工具 tool_end 渲染 ✓ + 耗时", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer });
    renderer.handleEvent({
      type: "tool_start",
      id: "tc1",
      name: "read",
      input: { path: "a.ts" },
    });
    renderer.handleEvent({
      type: "tool_end",
      id: "tc1",
      name: "read",
      result: { content: "ok", isError: false },
      duration: 50,
    });
    const out = stripAnsi(writer.buffer);
    expect(out).toContain("✓");
    expect(out).toContain("50ms");
  });

  it("混合序列 read + Task + write → 仅 read/write 渲染 ⟡，Task 静默", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer });
    renderer.handleEvent({
      type: "tool_start",
      id: "t1",
      name: "read",
      input: { path: "a.ts" },
    });
    renderer.handleEvent({
      type: "tool_end",
      id: "t1",
      name: "read",
      result: { content: "ok", isError: false },
      duration: 10,
    });
    renderer.handleEvent({
      type: "tool_start",
      id: "t2",
      name: "Task",
      input: { description: "x", prompt: "..." },
    });
    renderer.handleEvent({
      type: "tool_end",
      id: "t2",
      name: "Task",
      result: { content: "ok", isError: false },
      duration: 1000,
    });
    renderer.handleEvent({
      type: "tool_start",
      id: "t3",
      name: "write",
      input: { path: "b.ts" },
    });

    const out = stripAnsi(writer.buffer);
    expect(out).toContain("read");
    expect(out).toContain("write");
    expect(out).not.toContain("Task");
    expect(out).not.toContain("1000ms");
  });
});
