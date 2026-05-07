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

describe("createOutputRenderer · 工具卡片渲染", () => {
  it("default 工具 tool_start 不立即写 scrollback——进行中视觉由状态条接管", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer });
    renderer.handleEvent({
      type: "tool_start",
      id: "tc1",
      name: "read",
      input: { path: "a.ts" },
    });
    expect(writer.buffer).toBe("");
  });

  it("Task 工具 tool_start → 主路径完全静默（sub-agent-status 接管）", () => {
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

  it("default 工具 tool_end 渲染 ◆ Action(target) + ⎿ result 双行卡片", () => {
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
      result: { content: "line1\nline2\nline3", isError: false },
      duration: 50,
    });
    const out = stripAnsi(writer.buffer);
    expect(out).toContain("◆");
    expect(out).toContain("Read(a.ts)");
    expect(out).toContain("⎿");
    expect(out).toContain("3 lines");
  });

  it("失败工具 tool_end —— ◆ 锚 + Action(target) + error 首行", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer });
    renderer.handleEvent({
      type: "tool_start",
      id: "tc1",
      name: "read",
      input: { path: "missing.ts" },
    });
    renderer.handleEvent({
      type: "tool_end",
      id: "tc1",
      name: "read",
      result: { content: "ENOENT: no such file", isError: true },
      duration: 10,
    });
    const out = stripAnsi(writer.buffer);
    expect(out).toContain("◆");
    expect(out).toContain("Read(missing.ts)");
    expect(out).toContain("ENOENT: no such file");
  });

  it("混合序列 read + Task + write —— Task 静默 / read 与 write 各产生卡片", () => {
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
    renderer.handleEvent({
      type: "tool_end",
      id: "t3",
      name: "write",
      result: { content: "done", isError: false },
      duration: 5,
    });

    const out = stripAnsi(writer.buffer);
    expect(out).toContain("Read(a.ts)");
    expect(out).toContain("Write(b.ts)");
    expect(out).not.toContain("Task(");
    // ◆ 锚出现两次（read + write 各一）
    const anchors = out.match(/◆/g) ?? [];
    expect(anchors.length).toBe(2);
  });

  it("turn_complete 清理未配对的 pendingToolInputs（防御性 invariant）", () => {
    const writer = makeCaptureWriter();
    const renderer = createOutputRenderer({ writer });
    // 异常路径：tool_start 后流被打断，没有 tool_end，turn_complete 兜底清理
    renderer.handleEvent({
      type: "tool_start",
      id: "orphan",
      name: "read",
      input: { path: "a.ts" },
    });
    renderer.handleEvent({
      type: "turn_complete",
      turnCount: 1,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    // 下一轮起步——同 id（orphan）的 tool_end 不应再渲染（缓存已清理，input 退化为空）
    renderer.handleEvent({
      type: "tool_end",
      id: "orphan",
      name: "read",
      result: { content: "x\ny", isError: false },
      duration: 5,
    });
    const out = stripAnsi(writer.buffer);
    // header 退化为 `Read`（无 target），证明 input 已被 turn_complete 清理
    expect(out).toContain("Read");
    expect(out).not.toContain("Read(a.ts)");
  });
});
