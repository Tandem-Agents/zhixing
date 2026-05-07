import { describe, expect, it, vi } from "vitest";
import type {
  AbortReason,
  AgentEventMap,
} from "@zhixing/core";
import { createEventBus } from "@zhixing/core";
import {
  createRenderSubscribers,
  formatAbortReasonSummary,
  renderUsageReport,
  setupInterruptRendering,
} from "../render.js";
import type { SubAgentUsageEntry } from "../parse-task-usage.js";
import type { ContextBudget } from "@zhixing/core";
import type { CliWriter } from "../screen/index.js";

// ─── CliWriter 测试桩——按段累积 line / notify 调用 ───

interface CapturedWriter extends CliWriter {
  /** 累积所有 line / notify / appendInline 写入（含 \n 落地） */
  readonly buffer: string;
  /** 累积 line 调用文本（不含落地 \n，方便单元测试断言原始内容） */
  readonly lines: string[];
  readonly notices: string[];
}

function makeCaptureWriter(): CapturedWriter {
  let buffer = "";
  const lines: string[] = [];
  const notices: string[] = [];
  return {
    get buffer() {
      return buffer;
    },
    lines,
    notices,
    line(text) {
      lines.push(text);
      buffer += text;
      if (!text.endsWith("\n")) buffer += "\n";
    },
    appendInline(text) {
      buffer += text;
    },
    notify(text) {
      notices.push(text);
      buffer += text;
      if (!text.endsWith("\n")) buffer += "\n";
    },
  } as CapturedWriter;
}

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\[[0-9;]*m/g, "");

describe("formatAbortReasonSummary", () => {
  it("undefined → 兜底 'interrupted' (外部裸 abort 无类型化 reason)", () => {
    expect(formatAbortReasonSummary(undefined)).toBe("interrupted");
  });

  it("null → 兜底 'interrupted' (与 undefined 等价)", () => {
    expect(formatAbortReasonSummary(null)).toBe("interrupted");
  });

  it("user-cancel + esc → 'interrupted by user (esc)'", () => {
    const reason: AbortReason = { kind: "user-cancel", source: "esc", pressedAt: 100 };
    expect(formatAbortReasonSummary(reason)).toBe("interrupted by user (esc)");
  });

  it("user-cancel + ctrl-c → 'interrupted by user (ctrl+c)' (符号显示)", () => {
    const reason: AbortReason = { kind: "user-cancel", source: "ctrl-c", pressedAt: 100 };
    expect(formatAbortReasonSummary(reason)).toBe("interrupted by user (ctrl+c)");
  });

  it("user-cancel + sigint → 'interrupted by user (sigint)'", () => {
    const reason: AbortReason = { kind: "user-cancel", source: "sigint", pressedAt: 100 };
    expect(formatAbortReasonSummary(reason)).toBe("interrupted by user (sigint)");
  });

  it("user-cancel + rpc → 'interrupted by user (rpc)'", () => {
    const reason: AbortReason = { kind: "user-cancel", source: "rpc", pressedAt: 100 };
    expect(formatAbortReasonSummary(reason)).toBe("interrupted by user (rpc)");
  });

  it("idle-timeout → 'interrupted: stream idle for Ns (K chunks received)'", () => {
    const reason: AbortReason = {
      kind: "idle-timeout",
      timeoutMs: 60_000,
      chunksReceived: 0,
      elapsedSinceLastChunkMs: 60_100,
    };
    expect(formatAbortReasonSummary(reason)).toBe(
      "interrupted: stream idle for 60s (0 chunks received)",
    );
  });

  it("idle-timeout 反映已收到 chunk 数", () => {
    const reason: AbortReason = {
      kind: "idle-timeout",
      timeoutMs: 90_000,
      chunksReceived: 12,
      elapsedSinceLastChunkMs: 90_500,
    };
    expect(formatAbortReasonSummary(reason)).toBe(
      "interrupted: stream idle for 90s (12 chunks received)",
    );
  });

  it("parent-abort + 父 reason 已知 → 透传父 kind", () => {
    const reason: AbortReason = {
      kind: "parent-abort",
      parentReason: { kind: "user-cancel", source: "esc", pressedAt: 50 },
    };
    expect(formatAbortReasonSummary(reason)).toBe("interrupted by parent (user-cancel)");
  });

  it("parent-abort + 父 reason 为 null (祖父裸 abort) → 显示 'unknown'", () => {
    const reason: AbortReason = {
      kind: "parent-abort",
      parentReason: null,
    };
    expect(formatAbortReasonSummary(reason)).toBe("interrupted by parent (unknown)");
  });

  it("external 无 origin → 'interrupted by external signal'", () => {
    const reason: AbortReason = { kind: "external" };
    expect(formatAbortReasonSummary(reason)).toBe("interrupted by external signal");
  });

  it("external 带 origin → 'interrupted by external signal (X)'", () => {
    const reason: AbortReason = { kind: "external", origin: "scheduler-task-timeout" };
    expect(formatAbortReasonSummary(reason)).toBe(
      "interrupted by external signal (scheduler-task-timeout)",
    );
  });
});

describe("renderUsageReport: 子 agent Task 拆分段", () => {
  const baseBudget: ContextBudget = {
    currentTokens: 5_100,
    effectiveWindow: 130_000,
    contextWindow: 200_000,
    usageRatio: 0.04,
    status: "normal",
  };

  it("subUsages 不传 → 仅渲染主 agent 用量段", () => {
    const writer = makeCaptureWriter();
    renderUsageReport(baseBudget, 3, undefined, undefined, writer);
    const out = stripAnsi(writer.buffer);
    expect(out).toContain("Token 用量");
    expect(out).toContain("上下文容量");
    expect(out).not.toContain("子 agent 拆分");
    expect(out).not.toContain("Sum");
  });

  it("subUsages 空数组 → 与不传等价(子段不出现)", () => {
    const writer = makeCaptureWriter();
    renderUsageReport(baseBudget, 3, undefined, [], writer);
    const out = stripAnsi(writer.buffer);
    expect(out).not.toContain("子 agent 拆分");
    expect(out).not.toContain("Sum");
  });

  it("succeeded entry → 显示 ✓ + tokensFmt + tool_uses + duration(秒制)", () => {
    const writer = makeCaptureWriter();
    const entries: SubAgentUsageEntry[] = [
      {
        index: 1,
        description: "调研模块结构",
        tokens: 35_400,
        toolUses: 5,
        durationMs: 8000,
        subId: "ab12cd",
        status: "succeeded",
      },
    ];
    renderUsageReport(baseBudget, 3, undefined, entries, writer);
    const out = stripAnsi(writer.buffer);
    expect(out).toContain("子 agent 拆分");
    expect(out).toContain("Task#1");
    expect(out).toContain("调研模块结构");
    expect(out).toContain("✓");
    expect(out).toContain("35.4K");
    expect(out).toContain("5 tool_uses");
    expect(out).toContain("8.00s");
  });

  it("toolUses=1 → 单数 'tool_use'(不带 s)", () => {
    const writer = makeCaptureWriter();
    const entries: SubAgentUsageEntry[] = [
      {
        index: 1,
        description: "single",
        tokens: 100,
        toolUses: 1,
        durationMs: 500,
        subId: "111111",
        status: "succeeded",
      },
    ];
    renderUsageReport(baseBudget, 3, undefined, entries, writer);
    const out = stripAnsi(writer.buffer);
    expect(out).toContain("1 tool_use");
    expect(out).not.toContain("1 tool_uses");
  });

  it("failed entry → 显示 ⚠ + tokensFmt + (failed) 标识，无 tool_uses 字段", () => {
    const writer = makeCaptureWriter();
    const entries: SubAgentUsageEntry[] = [
      {
        index: 2,
        description: "查 API",
        tokens: 12_300,
        durationMs: 3000,
        subId: "fa11ed",
        status: "failed",
      },
    ];
    renderUsageReport(baseBudget, 3, undefined, entries, writer);
    const out = stripAnsi(writer.buffer);
    expect(out).toContain("Task#2");
    expect(out).toContain("⚠");
    expect(out).toContain("12.3K");
    expect(out).toContain("(failed)");
    expect(out).not.toContain("tool_use");
  });

  it("aborted entry → 显示 ⏵ + (aborted) 标识", () => {
    const writer = makeCaptureWriter();
    const entries: SubAgentUsageEntry[] = [
      {
        index: 3,
        description: "总结",
        tokens: 2_000,
        durationMs: 1500,
        subId: "abc123",
        status: "aborted",
      },
    ];
    renderUsageReport(baseBudget, 3, undefined, entries, writer);
    const out = stripAnsi(writer.buffer);
    expect(out).toContain("Task#3");
    expect(out).toContain("⏵");
    expect(out).toContain("(aborted)");
  });

  it("多 entry → 求和行 Sum 等于各 entry tokens 之和", () => {
    const writer = makeCaptureWriter();
    const entries: SubAgentUsageEntry[] = [
      {
        index: 1,
        description: "a",
        tokens: 35_400,
        toolUses: 5,
        durationMs: 1000,
        subId: "111111",
        status: "succeeded",
      },
      {
        index: 2,
        description: "b",
        tokens: 12_300,
        durationMs: 1000,
        subId: "222222",
        status: "failed",
      },
      {
        index: 3,
        description: "c",
        tokens: 7_400,
        toolUses: 1,
        durationMs: 1000,
        subId: "333333",
        status: "succeeded",
      },
    ];
    renderUsageReport(baseBudget, 3, undefined, entries, writer);
    const out = stripAnsi(writer.buffer);
    expect(out).toContain("Sum");
    expect(out).toContain("55.1K");
    expect(out).toContain("3 个 Task");
  });

  it("description 超过 28 字符 → 截断 + 省略号 …", () => {
    const writer = makeCaptureWriter();
    const longDesc = "a".repeat(50);
    const entries: SubAgentUsageEntry[] = [
      {
        index: 1,
        description: longDesc,
        tokens: 100,
        toolUses: 1,
        durationMs: 100,
        subId: "111111",
        status: "succeeded",
      },
    ];
    renderUsageReport(baseBudget, 3, undefined, entries, writer);
    const out = stripAnsi(writer.buffer);
    expect(out).toContain("…");
    expect(out).not.toContain("a".repeat(50));
  });
});

describe("setupInterruptRendering: 走 CliWriter 协调", () => {
  const pauseUI = vi.fn();

  it("warn 触发 → writer.notify 单次写警告 + pauseUI 调用", async () => {
    pauseUI.mockClear();
    const writer = makeCaptureWriter();
    const bus = createEventBus<AgentEventMap>();
    const handle = setupInterruptRendering(bus, pauseUI, writer);

    await bus.emit("interrupt:warn", {
      kind: "idle-timeout-warn",
      elapsedMs: 30_000,
      timeoutMs: 60_000,
      chunksReceived: 0,
    });

    expect(pauseUI).toHaveBeenCalled();
    // 单次 notify——剩余秒数 = (60000 - 30000) / 1000 = 30
    expect(writer.notices.length).toBe(1);
    expect(stripAnsi(writer.notices[0]!)).toContain("auto-cancel in 30s");

    handle.dispose();
  });

  it("warn 走 notify（独占模式排队语义）→ 不打断流式 LLM 输出", async () => {
    pauseUI.mockClear();
    const writer = makeCaptureWriter();
    const bus = createEventBus<AgentEventMap>();
    const handle = setupInterruptRendering(bus, pauseUI, writer);

    await bus.emit("interrupt:warn", {
      kind: "idle-timeout-warn",
      elapsedMs: 30_000,
      timeoutMs: 60_000,
      chunksReceived: 0,
    });

    // 警告走 notify（不是 line）——表达"任意时刻可能触发"的语义，与同步段落 line 区分
    expect(writer.notices.length).toBe(1);
    expect(writer.lines.length).toBe(0);

    handle.dispose();
  });

  it("fired 触发 → writer.line 标记 [interrupted] + pauseUI 调用", async () => {
    pauseUI.mockClear();
    const writer = makeCaptureWriter();
    const bus = createEventBus<AgentEventMap>();
    const handle = setupInterruptRendering(bus, pauseUI, writer);

    await bus.emit("interrupt:fired", {
      reason: { kind: "user-cancel", source: "esc", pressedAt: 1 },
      interruptedTurnIndex: 0,
      exitDelayMs: 5,
      toolGraceMs: 0,
    });

    expect(pauseUI).toHaveBeenCalled();
    expect(writer.lines.length).toBe(1);
    expect(stripAnsi(writer.lines[0]!)).toContain("[interrupted]");

    // reason 文本不在 setupInterruptRendering 路径输出（由 status-bar done 状态展示）
    expect(stripAnsi(writer.buffer)).not.toContain("interrupted by user");

    handle.dispose();
  });

  it("dispose → 后续事件不再响应", async () => {
    pauseUI.mockClear();
    const writer = makeCaptureWriter();
    const bus = createEventBus<AgentEventMap>();
    const handle = setupInterruptRendering(bus, pauseUI, writer);
    handle.dispose();

    await bus.emit("interrupt:warn", {
      kind: "idle-timeout-warn",
      elapsedMs: 30_000,
      timeoutMs: 60_000,
      chunksReceived: 0,
    });
    await bus.emit("interrupt:fired", {
      reason: { kind: "user-cancel", source: "esc", pressedAt: 1 },
      interruptedTurnIndex: 0,
      exitDelayMs: 5,
      toolGraceMs: 0,
    });

    expect(writer.notices).toEqual([]);
    expect(writer.lines).toEqual([]);
  });
});

describe("createRenderSubscribers: 工厂注入语义", () => {
  it("无 renderer + 仅 writer → pauseUI 退化为 no-op，事件渲染照常", async () => {
    const writer = makeCaptureWriter();
    const bus = createEventBus<AgentEventMap>();
    const decorator = createRenderSubscribers({ writer });
    const teardown = decorator({ bus, runId: "test", parentBus: null });

    await bus.emit("retry:attempt", {
      errorType: "timeout",
      attempt: 2,
      maxRetries: 3,
      delayMs: 1500,
    });

    const out = stripAnsi(writer.buffer);
    expect(out).toContain("第 2/3 次重试");
    expect(out).toContain("请求超时");

    teardown();
  });
});
