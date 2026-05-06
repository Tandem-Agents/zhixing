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
  createRenderSubscribers,
  formatAbortReasonSummary,
  renderSummary,
  renderUsageReport,
  setupInterruptRendering,
} from "../render.js";
import type { SubAgentUsageEntry } from "../parse-task-usage.js";
import type { ContextBudget } from "@zhixing/core";

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

// TokenUsage 零值 helper:仅 inputTokens / outputTokens 必填,cacheReadTokens /
// cacheWriteTokens 是 optional 维度,本套测试不验缓存语义,故省略保持最小契约
const usageZero = { inputTokens: 0, outputTokens: 0 };

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

// ─── renderUsageReport: 子 agent 拆分段 ───

describe("renderUsageReport: 子 agent Task 拆分段", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const allOutput = (): string =>
    stripAnsi(logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n"));

  const baseBudget: ContextBudget = {
    currentTokens: 5_100,
    effectiveWindow: 130_000,
    contextWindow: 200_000,
    usageRatio: 0.04,
    status: "normal",
  };

  it("subUsages 不传 → 仅渲染主 agent 用量段(向后兼容,无子段标题)", () => {
    renderUsageReport(baseBudget, 3);
    const out = allOutput();
    expect(out).toContain("Token 用量");
    expect(out).toContain("上下文容量");
    expect(out).not.toContain("子 agent 拆分");
    expect(out).not.toContain("Sum");
  });

  it("subUsages 空数组 → 与不传等价(子段不出现)", () => {
    renderUsageReport(baseBudget, 3, undefined, []);
    const out = allOutput();
    expect(out).not.toContain("子 agent 拆分");
    expect(out).not.toContain("Sum");
  });

  it("succeeded entry → 显示 ✓ + tokensFmt + tool_uses + duration(秒制)", () => {
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
    renderUsageReport(baseBudget, 3, undefined, entries);
    const out = allOutput();
    expect(out).toContain("子 agent 拆分");
    expect(out).toContain("Task#1");
    expect(out).toContain("调研模块结构");
    expect(out).toContain("✓");
    expect(out).toContain("35.4K");
    expect(out).toContain("5 tool_uses");
    expect(out).toContain("8.00s");
  });

  it("toolUses=1 → 单数 'tool_use'(不带 s)", () => {
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
    renderUsageReport(baseBudget, 3, undefined, entries);
    const out = allOutput();
    expect(out).toContain("1 tool_use");
    expect(out).not.toContain("1 tool_uses");
  });

  it("failed entry → 显示 ⚠ + tokensFmt + (failed) 标识,无 tool_uses 字段", () => {
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
    renderUsageReport(baseBudget, 3, undefined, entries);
    const out = allOutput();
    expect(out).toContain("Task#2");
    expect(out).toContain("⚠");
    expect(out).toContain("12.3K");
    expect(out).toContain("(failed)");
    expect(out).not.toContain("tool_use");
  });

  it("aborted entry → 显示 ⏵ + (aborted) 标识", () => {
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
    renderUsageReport(baseBudget, 3, undefined, entries);
    const out = allOutput();
    expect(out).toContain("Task#3");
    expect(out).toContain("⏵");
    expect(out).toContain("(aborted)");
  });

  it("多 entry → 求和行 Sum 等于各 entry tokens 之和", () => {
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
    renderUsageReport(baseBudget, 3, undefined, entries);
    const out = allOutput();
    // Sum = 55,100 → 55.1K
    expect(out).toContain("Sum");
    expect(out).toContain("55.1K");
    expect(out).toContain("3 个 Task");
  });

  it("description 超过 28 字符 → 截断 + 省略号 …,不破坏单行布局", () => {
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
    renderUsageReport(baseBudget, 3, undefined, entries);
    const out = allOutput();
    expect(out).toContain("…");
    // 截断后不应保留全部 50 个 a
    expect(out).not.toContain("a".repeat(50));
  });
});

// ─── setupInterruptRendering: 时序与协调 ───

describe("setupInterruptRendering: 倒计时 ticker + 事件协调", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTTY: boolean | undefined;
  const pauseUI = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // 锚定 TTY 模式让测试覆盖 \r 单行刷新路径 (vitest 默认非 TTY 走的是 console.warn 一次性输出)
    originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
    pauseUI.mockClear();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    // 恢复 isTTY 原值 (vi.restoreAllMocks 不处理 defineProperty)
    if (originalIsTTY === undefined) {
      delete (process.stderr as unknown as { isTTY?: boolean }).isTTY;
    } else {
      Object.defineProperty(process.stderr, "isTTY", {
        configurable: true,
        value: originalIsTTY,
      });
    }
  });

  const findStderrContaining = (substr: string): string | undefined => {
    for (const call of stderrSpy.mock.calls) {
      const text = stripAnsi(String(call[0] ?? ""));
      if (text.includes(substr)) return text;
    }
    return undefined;
  };

  it("TTY 模式: warn 触发 → \\r 单行刷新, 立即输出 + 每秒更新", async () => {
    const bus = createEventBus<AgentEventMap>();
    const handle = setupInterruptRendering(bus, pauseUI);

    await bus.emit("interrupt:warn", {
      kind: "idle-timeout-warn",
      elapsedMs: 30_000,
      timeoutMs: 60_000,
      chunksReceived: 0,
    });

    // 立即输出: deadline = now + (60000 - 30000) = now + 30s → 显示 "30s"
    expect(findStderrContaining("auto-cancel in 30s")).toBeDefined();
    expect(pauseUI).toHaveBeenCalled();

    // 输出走 \r 前缀 (单行原地刷新, 非新行)
    const writes = stderrSpy.mock.calls.map((c) => String(c[0]));
    const tickWrites = writes.filter((s) => stripAnsi(s).includes("auto-cancel"));
    expect(tickWrites.every((s) => s.startsWith("\r"))).toBe(true);

    // 1s 后 ticker 触发, 显示 "29s"
    await vi.advanceTimersByTimeAsync(1000);
    expect(findStderrContaining("auto-cancel in 29s")).toBeDefined();

    handle.dispose();
  });

  it("TTY 模式: 第一次 tick 前先打 \\n (隔开 watchdog 自身日志/spinner 残留, 避免同行混杂)", async () => {
    const bus = createEventBus<AgentEventMap>();
    const handle = setupInterruptRendering(bus, pauseUI);

    await bus.emit("interrupt:warn", {
      kind: "idle-timeout-warn",
      elapsedMs: 30_000,
      timeoutMs: 60_000,
      chunksReceived: 0,
    });

    // stderr 第一次写入应是单独的 "\n" (在倒计时之前), 后续才是 \r 倒计时
    const writes = stderrSpy.mock.calls.map((c) => String(c[0]));
    const newlineIdx = writes.findIndex((s) => s === "\n");
    const tickIdx = writes.findIndex((s) => stripAnsi(s).includes("auto-cancel"));
    expect(newlineIdx).toBeGreaterThanOrEqual(0);
    expect(tickIdx).toBeGreaterThan(newlineIdx);
    handle.dispose();
  });

  it("非 TTY 模式: 仅 console.warn 一次, 不启动 ticker (避免 CI / pipe 日志爆炸)", async () => {
    Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: false });
    const bus = createEventBus<AgentEventMap>();
    const handle = setupInterruptRendering(bus, pauseUI);

    await bus.emit("interrupt:warn", {
      kind: "idle-timeout-warn",
      elapsedMs: 30_000,
      timeoutMs: 60_000,
      chunksReceived: 0,
    });

    // 非 TTY 走 console.warn 一次, 不调 process.stderr.write
    const found = warnSpy.mock.calls.find((c) => stripAnsi(String(c[0])).includes("auto-cancel"));
    expect(found).toBeDefined();

    // 推 5s 不应有新 ticker 输出 (非 TTY 不启动 setInterval)
    const callsBefore = warnSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(warnSpy.mock.calls.length).toBe(callsBefore);
    handle.dispose();
  });

  it("stream_event 到达 → ticker 清理 + 倒计时残留行被擦除", async () => {
    const bus = createEventBus<AgentEventMap>();
    const handle = setupInterruptRendering(bus, pauseUI);

    await bus.emit("interrupt:warn", {
      kind: "idle-timeout-warn",
      elapsedMs: 30_000,
      timeoutMs: 60_000,
      chunksReceived: 0,
    });
    stderrSpy.mockClear();

    await bus.emit("llm:stream_event", { type: "text_delta", text: "chunk" });

    // 清行: 写入 \r + 空格 + \r 把光标拉回干净行首
    const cleared = stderrSpy.mock.calls.find((c) => /^\r {3,}\r$/.test(String(c[0])));
    expect(cleared).toBeDefined();

    // 推 5 秒无新 ticker 输出
    stderrSpy.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    const newTicks = stderrSpy.mock.calls.filter((c) =>
      stripAnsi(String(c[0])).includes("auto-cancel"),
    );
    expect(newTicks).toEqual([]);
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
    stderrSpy.mockClear();

    // chunk 后 watchdog 重新 arm, 30s 后再次 warn
    await bus.emit("interrupt:warn", {
      kind: "idle-timeout-warn",
      elapsedMs: 30_000,
      timeoutMs: 60_000,
      chunksReceived: 5,
    });

    expect(findStderrContaining("auto-cancel in 30s")).toBeDefined();
    handle.dispose();
  });

  it("fired 触发 → 仅 dim [interrupted] 视觉标记 + 清理 ticker + 擦倒计时残留", async () => {
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
    stderrSpy.mockClear();

    await bus.emit("interrupt:fired", {
      reason: { kind: "user-cancel", source: "esc", pressedAt: 1 },
      interruptedTurnIndex: 0,
      exitDelayMs: 5,
      toolGraceMs: 0,
    });

    // [interrupted] 走 stdout (与 LLM 文本同 stream, 形成视觉连续)
    const stdoutCalls = stdoutSpy.mock.calls.map((c) => stripAnsi(String(c[0])));
    expect(stdoutCalls.some((s) => s.includes("[interrupted]"))).toBe(true);

    // 倒计时残留行被擦除 (\r + 空格 + \r)
    const cleared = stderrSpy.mock.calls.find((c) => /^\r {3,}\r$/.test(String(c[0])));
    expect(cleared).toBeDefined();

    // reason 文本不重复输出 (由摘要行展示)
    const reasonInWarn = warnSpy.mock.calls.find((c) =>
      stripAnsi(String(c[0])).includes("interrupted by user"),
    );
    const reasonInStderr = stderrSpy.mock.calls.find((c) =>
      stripAnsi(String(c[0])).includes("interrupted by user"),
    );
    expect(reasonInWarn).toBeUndefined();
    expect(reasonInStderr).toBeUndefined();

    // ticker 清理: 推 5s 无新 ticker 输出
    stderrSpy.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    const newTicks = stderrSpy.mock.calls.filter((c) =>
      stripAnsi(String(c[0])).includes("auto-cancel"),
    );
    expect(newTicks).toEqual([]);
    handle.dispose();
  });

  it("run_end 兜底清理 ticker (没 fired 也清理 + 擦残留)", async () => {
    const bus = createEventBus<AgentEventMap>();
    const handle = setupInterruptRendering(bus, pauseUI);

    await bus.emit("interrupt:warn", {
      kind: "idle-timeout-warn",
      elapsedMs: 30_000,
      timeoutMs: 60_000,
      chunksReceived: 0,
    });
    stderrSpy.mockClear();

    await bus.emit("agent:run_end", {
      reason: "completed",
      duration: 100,
      usage: usageZero,
    });

    // 倒计时残留被擦除
    const cleared = stderrSpy.mock.calls.find((c) => /^\r {3,}\r$/.test(String(c[0])));
    expect(cleared).toBeDefined();

    // 推 5s 无新 ticker 输出
    stderrSpy.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    const newTicks = stderrSpy.mock.calls.filter((c) =>
      stripAnsi(String(c[0])).includes("auto-cancel"),
    );
    expect(newTicks).toEqual([]);
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

    const ticks = stderrSpy.mock.calls.filter((c) =>
      stripAnsi(String(c[0])).includes("auto-cancel"),
    );
    expect(ticks).toEqual([]);
    expect(warnSpy.mock.calls.length).toBe(0);
  });
});

// ─── createRenderSubscribers · 集成 SubAgentStatus ───
//
// 验证 createRenderSubscribers 装载了 setupSubAgentStatus,确保子 agent 状态条
// 订阅与既有 retry / interrupt / context 订阅并列且共享 dispose 路径。
// 不重复 sub-agent-status.test.ts 的细节断言,只锚定"集成已发生 + dispose 全清"。
describe("createRenderSubscribers · SubAgentStatus 集成", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalIsTTY === undefined) {
      delete (process.stdout as unknown as { isTTY?: boolean }).isTTY;
    } else {
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: originalIsTTY,
      });
    }
  });

  it("装载后 emit 主 Task 事件 → stdout 出现 [Task#1: ...] 状态条输出", async () => {
    const bus = createEventBus<AgentEventMap>({ lineage: "main" });
    const decorator = createRenderSubscribers(); // 无 renderer 时 pauseUI no-op
    const dispose = decorator({ bus });

    await bus.emit("tool:call_start", {
      id: "tc1",
      name: "Task",
      input: { description: "测试集成", prompt: "..." },
    });

    const out = stdoutSpy.mock.calls
      .map((c) => stripAnsi(String(c[0] ?? "")))
      .join("");
    expect(out).toContain("[Task#1: 测试集成]");

    dispose();
  });

  it("dispose 全清:释放 SubAgentStatus + InterruptRendering + retry/context 订阅", async () => {
    const bus = createEventBus<AgentEventMap>({ lineage: "main" });
    const decorator = createRenderSubscribers();
    const dispose = decorator({ bus });
    dispose();

    stdoutSpy.mockClear();

    // 释放后所有事件都不应触发任何渲染器输出
    await bus.emit("tool:call_start", {
      id: "tc1",
      name: "Task",
      input: { description: "x", prompt: "..." },
    });
    await bus.emit("retry:attempt", {
      errorType: "timeout",
      attempt: 1,
      maxRetries: 3,
      delayMs: 1000,
    });

    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});

// ─── Renderer.handleEvent · 派发型工具不渲染 ⟡ 卡片(P0 防回归) ───
//
// 主路径 onYield 的 tool_start/tool_end 与 EventBus 的 tool:call_start/end 同步发生,
// 若 renderer.handleEvent 仍渲染派发型工具(如 Task)的 ⟡ 卡片,会与
// setupSubAgentStatus 的状态条形成双重渲染视觉混乱。本测试套锁定:
//   - 默认工具(read/write/bash 等)正常渲染 ⟡ 卡片
//   - 策略表标记非 default 的工具(Task)主路径完全静默,交由专用订阅器接管
//
// 与 sub-agent-status.test.ts 互补 —— 那边测"状态条接管路径",这边测"主路径让位"。
