import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AbortReason,
  AgentError,
  AgentEventMap,
  AgentResult,
  Message,
} from "@zhixing/core";
import { createEventBus } from "@zhixing/core";
import {
  formatAbortReasonSummary,
  renderSummary,
  setupInterruptRendering,
} from "../render.js";

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

// ─── renderSummary: 终止类型差异化 ───
//
// 验证 4 个 AgentResult variant (completed / aborted / max_turns / error) 各自的
// 摘要文本。用 spyOn(console, "log") 捕获输出, 检查关键字符串(去 ANSI 颜色码后比较)。

const stripAnsi = (s: string): string =>
  // 去 chalk 颜色 ANSI 转义码, 让断言聚焦语义文本不依赖颜色实现
  // eslint-disable-next-line no-control-regex
  s.replace(/\[[0-9;]*m/g, "");

const usageZero = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 };

describe("renderSummary: 终止类型差异化", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const lastLogLine = (): string => {
    const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1];
    return stripAnsi(String(lastCall?.[0] ?? ""));
  };

  it("aborted + user-cancel(esc) → 'interrupted by user (esc)' + 时间", () => {
    const result: AgentResult = {
      reason: "aborted",
      usage: usageZero,
      abortReason: { kind: "user-cancel", source: "esc", pressedAt: 1 },
    };
    renderSummary(result, 1234);
    const out = lastLogLine();
    expect(out).toContain("interrupted by user (esc)");
    expect(out).toContain("1.2s");
  });

  it("aborted + idle-timeout → 'interrupted: stream idle for Ns'", () => {
    const result: AgentResult = {
      reason: "aborted",
      usage: usageZero,
      abortReason: {
        kind: "idle-timeout",
        timeoutMs: 60_000,
        chunksReceived: 5,
        elapsedSinceLastChunkMs: 60_500,
      },
    };
    renderSummary(result, 60_500);
    const out = lastLogLine();
    expect(out).toContain("interrupted: stream idle for 60s (5 chunks received)");
  });

  it("aborted + parent-abort → 'interrupted by parent (kind)'", () => {
    const result: AgentResult = {
      reason: "aborted",
      usage: usageZero,
      abortReason: {
        kind: "parent-abort",
        parentReason: { kind: "user-cancel", source: "ctrl-c", pressedAt: 1 },
      },
    };
    renderSummary(result, 100);
    const out = lastLogLine();
    expect(out).toContain("interrupted by parent (user-cancel)");
  });

  it("aborted 无 abortReason (外部裸 abort) → 'interrupted' 兜底", () => {
    const result: AgentResult = { reason: "aborted", usage: usageZero };
    renderSummary(result, 100);
    const out = lastLogLine();
    expect(out).toContain("interrupted");
    expect(out).not.toContain("user");
    expect(out).not.toContain("parent");
  });

  it("max_turns → 'max turns reached (N)' 用 result.maxTurns 不读 abortReason", () => {
    const result: AgentResult = {
      reason: "max_turns",
      maxTurns: 50,
      usage: usageZero,
    };
    renderSummary(result, 5000);
    const out = lastLogLine();
    expect(out).toContain("max turns reached (50)");
    expect(out).toContain("5.0s");
    // 不应混入 abort/interrupted 文本
    expect(out).not.toContain("interrupted");
  });

  it("error → 'error: <type>' 显示分类", () => {
    const error = {
      type: "context_overflow",
      message: "Context window exceeded",
      recoverable: false,
    } as AgentError;
    const result: AgentResult = { reason: "error", error, usage: usageZero };
    renderSummary(result, 200);
    const out = lastLogLine();
    expect(out).toContain("error: context_overflow");
  });

  it("completed + budget critical → 显示红色上下文百分比", () => {
    const message: Message = { role: "assistant", content: [{ type: "text", text: "ok" }] };
    const result: AgentResult = { reason: "completed", message, usage: usageZero };
    renderSummary(result, 1000, {
      currentTokens: 95_000,
      effectiveWindow: 100_000,
      contextWindow: 100_000,
      usageRatio: 0.95,
      status: "critical",
    });
    const out = lastLogLine();
    expect(out).toContain("1.0s");
    expect(out).toContain("上下文 95%");
  });

  it("completed 无 budget → 仅显示时间", () => {
    const message: Message = { role: "assistant", content: [{ type: "text", text: "ok" }] };
    const result: AgentResult = { reason: "completed", message, usage: usageZero };
    renderSummary(result, 500);
    const out = lastLogLine();
    expect(out).toContain("0.5s");
    expect(out).not.toContain("上下文");
  });
});

// ─── setupInterruptRendering: 时序与协调 ───

describe("setupInterruptRendering: 倒计时 ticker + 事件协调", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  const pauseUI = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    pauseUI.mockClear();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const findWarnContaining = (substr: string): string | undefined => {
    for (const call of warnSpy.mock.calls) {
      const text = stripAnsi(String(call[0] ?? ""));
      if (text.includes(substr)) return text;
    }
    return undefined;
  };

  it("warn 触发 → 立即输出第一行 + 启动每秒 ticker", async () => {
    const bus = createEventBus<AgentEventMap>();
    const handle = setupInterruptRendering(bus, pauseUI);

    await bus.emit("interrupt:warn", {
      kind: "idle-timeout-warn",
      elapsedMs: 30_000,
      timeoutMs: 60_000,
      chunksReceived: 0,
    });

    // 立即输出: deadline = now + (60000 - 30000) = now + 30s → 显示 "30s"
    expect(findWarnContaining("auto-cancel in 30s")).toBeDefined();
    expect(pauseUI).toHaveBeenCalled();

    // 1s 后 ticker 触发, 显示 "29s"
    await vi.advanceTimersByTimeAsync(1000);
    expect(findWarnContaining("auto-cancel in 29s")).toBeDefined();

    handle.dispose();
  });

  it("stream_event 到达 → ticker 清理, 不再每秒输出", async () => {
    const bus = createEventBus<AgentEventMap>();
    const handle = setupInterruptRendering(bus, pauseUI);

    await bus.emit("interrupt:warn", {
      kind: "idle-timeout-warn",
      elapsedMs: 30_000,
      timeoutMs: 60_000,
      chunksReceived: 0,
    });
    const callsBefore = warnSpy.mock.calls.length;

    // chunk 到达 (任意 stream event), ticker 应停
    await bus.emit("llm:stream_event", { type: "text_delta", text: "chunk" });
    await vi.advanceTimersByTimeAsync(5000);

    // ticker 停 → 5 秒推进无新输出
    expect(warnSpy.mock.calls.length).toBe(callsBefore);
    handle.dispose();
  });

  it("第二次 warn 触发 → 重启 ticker (新周期)", async () => {
    const bus = createEventBus<AgentEventMap>();
    const handle = setupInterruptRendering(bus, pauseUI);

    await bus.emit("interrupt:warn", {
      kind: "idle-timeout-warn",
      elapsedMs: 30_000,
      timeoutMs: 60_000,
      chunksReceived: 0,
    });
    await bus.emit("llm:stream_event", { type: "text_delta", text: "chunk" });
    warnSpy.mockClear();

    // chunk 后 watchdog 重新 arm, 30s 后再次 warn
    await bus.emit("interrupt:warn", {
      kind: "idle-timeout-warn",
      elapsedMs: 30_000,
      timeoutMs: 60_000,
      chunksReceived: 5, // reset 后已收到 5 chunks
    });

    expect(findWarnContaining("auto-cancel in 30s")).toBeDefined();
    handle.dispose();
  });

  it("fired 触发 → 输出 [interrupted] + reason summary + 清理 ticker", async () => {
    const bus = createEventBus<AgentEventMap>();
    const handle = setupInterruptRendering(bus, pauseUI);

    await bus.emit("interrupt:warn", {
      kind: "idle-timeout-warn",
      elapsedMs: 30_000,
      timeoutMs: 60_000,
      chunksReceived: 0,
    });
    warnSpy.mockClear();
    stdoutSpy.mockClear();

    await bus.emit("interrupt:fired", {
      reason: { kind: "user-cancel", source: "esc", pressedAt: 1 },
      interruptedTurnIndex: 0,
      exitDelayMs: 5,
      toolGraceMs: 0,
    });

    // [interrupted] 标记走 stdout (与 LLM 文本同 stream)
    const stdoutCalls = stdoutSpy.mock.calls.map((c) => stripAnsi(String(c[0])));
    expect(stdoutCalls.some((s) => s.includes("[interrupted]"))).toBe(true);
    // summary 走 stderr
    expect(findWarnContaining("interrupted by user (esc)")).toBeDefined();

    // ticker 应被清理: 推 5s 无新输出 (除上面 fired 自身的)
    const callsAfterFired = warnSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(warnSpy.mock.calls.length).toBe(callsAfterFired);
    handle.dispose();
  });

  it("run_end 兜底清理 ticker (没 fired 也清理)", async () => {
    const bus = createEventBus<AgentEventMap>();
    const handle = setupInterruptRendering(bus, pauseUI);

    await bus.emit("interrupt:warn", {
      kind: "idle-timeout-warn",
      elapsedMs: 30_000,
      timeoutMs: 60_000,
      chunksReceived: 0,
    });
    warnSpy.mockClear();

    await bus.emit("agent:run_end", {
      reason: "completed",
      duration: 100,
      usage: usageZero,
    });

    await vi.advanceTimersByTimeAsync(5000);
    expect(warnSpy.mock.calls.length).toBe(0);
    handle.dispose();
  });

  it("dispose → 后续 warn 不再响应", async () => {
    const bus = createEventBus<AgentEventMap>();
    const handle = setupInterruptRendering(bus, pauseUI);
    handle.dispose();

    await bus.emit("interrupt:warn", {
      kind: "idle-timeout-warn",
      elapsedMs: 30_000,
      timeoutMs: 60_000,
      chunksReceived: 0,
    });

    expect(warnSpy.mock.calls.length).toBe(0);
  });
});
