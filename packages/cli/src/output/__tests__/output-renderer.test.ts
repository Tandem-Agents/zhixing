import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOutputRenderer } from "../output-renderer.js";
import { stripAnsi } from "../../tui/ansi.js";

describe("createOutputRenderer · 派发型工具不渲染 ⟡ 卡片", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("default 工具 (read) 正常渲染 ⟡ 卡片", () => {
    const renderer = createOutputRenderer();
    renderer.handleEvent({
      type: "tool_start",
      id: "tc1",
      name: "read",
      input: { path: "a.ts" },
    });
    const out = stdoutSpy.mock.calls
      .map((c) => stripAnsi(String(c[0] ?? "")))
      .join("");
    expect(out).toContain("⟡");
    expect(out).toContain("read");
    expect(out).toContain("a.ts");
  });

  it("Task 工具 tool_start → 主路径完全静默", () => {
    const renderer = createOutputRenderer();
    renderer.handleEvent({
      type: "tool_start",
      id: "tc1",
      name: "Task",
      input: { description: "x", prompt: "..." },
    });
    // 派发型工具由 setupSubAgentStatus 接管，主路径不写 stdout
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("Task 工具 tool_end → 主路径完全静默", () => {
    const renderer = createOutputRenderer();
    renderer.handleEvent({
      type: "tool_end",
      id: "tc1",
      name: "Task",
      result: { content: "ok", isError: false },
      duration: 100,
    });
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("default 工具 tool_end 渲染 ✓ + 耗时", () => {
    const renderer = createOutputRenderer();
    renderer.handleEvent({
      type: "tool_start",
      id: "tc1",
      name: "read",
      input: { path: "a.ts" },
    });
    stdoutSpy.mockClear();
    renderer.handleEvent({
      type: "tool_end",
      id: "tc1",
      name: "read",
      result: { content: "ok", isError: false },
      duration: 50,
    });
    const out = stdoutSpy.mock.calls
      .map((c) => stripAnsi(String(c[0] ?? "")))
      .join("");
    expect(out).toContain("✓");
    expect(out).toContain("50ms");
  });

  it("混合序列 read + Task + write → 仅 read/write 渲染 ⟡，Task 静默", () => {
    const renderer = createOutputRenderer();
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

    const out = stdoutSpy.mock.calls
      .map((c) => stripAnsi(String(c[0] ?? "")))
      .join("");
    expect(out).toContain("read");
    expect(out).toContain("write");
    // Task 名 / 耗时不在主路径输出
    expect(out).not.toContain("Task");
    expect(out).not.toContain("1000ms");
  });
});
