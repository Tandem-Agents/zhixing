import { describe, expect, it, vi } from "vitest";
import type {
  AbortReason,
  AgentEventMap,
  OrchestrationDefinitionV1,
  OrchestrationSystemCapsV1,
} from "@zhixing/core";
import {
  createEventBus,
  emptyUsage,
  loadOrchestrationDefinitionV1,
} from "@zhixing/core";
import {
  OrchestrationRunnerV1,
  type AgentNodeExecutorV1,
} from "@zhixing/orchestrator";
import {
  createRenderSubscribers,
  formatAbortReasonSummary,
  renderUsageReport,
  setupInterruptRendering,
} from "../render.js";
import {
  renderSubtaskSummaryLines,
  renderSubtaskUsageLines,
} from "../subtasks/presentation.js";
import { stringWidth } from "../tui/line-width.js";
import {
  PERSPECTIVES_DELIBERATION_DEFINITION_ID,
  type RuntimeSubAgentUsageEntry,
} from "@zhixing/server";
import type { ContextBudget } from "@zhixing/core";
import type { CliWriter } from "../screen/index.js";

// ─── CliWriter 测试桩——按段累积 line / notify 调用 ───

interface CapturedWriter extends CliWriter {
  /** 累积所有 line / notify / appendInline 写入（含 \n 落地） */
  readonly buffer: string;
  /** 累积 line 调用文本（不含落地 \n，方便单元测试断言原始内容） */
  readonly lines: string[];
  readonly notices: string[];
  readonly segmentBreaks: number;
}

function makeCaptureWriter(): CapturedWriter {
  let buffer = "";
  let segmentBreaks = 0;
  const lines: string[] = [];
  const notices: string[] = [];
  return {
    get buffer() {
      return buffer;
    },
    get segmentBreaks() {
      return segmentBreaks;
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
    ensureSegmentBreak() {
      segmentBreaks++;
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
    expect(out).not.toContain("子任务拆分");
    expect(out).not.toContain("子任务总计");
  });

  it("subUsages 空数组 → 与不传等价(子段不出现)", () => {
    const writer = makeCaptureWriter();
    renderUsageReport(baseBudget, 3, undefined, [], writer);
    const out = stripAnsi(writer.buffer);
    expect(out).not.toContain("子任务拆分");
    expect(out).not.toContain("子任务总计");
  });

  it("succeeded entry → 显示 ✓ + tokensFmt + 工具调用数 + duration", () => {
    const writer = makeCaptureWriter();
    const entries: RuntimeSubAgentUsageEntry[] = [
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
    expect(out).toContain("子任务拆分");
    expect(out).toContain("#1");
    expect(out).toContain("调研模块结构");
    expect(out).toContain("✓");
    expect(out).toContain("35.4k");
    expect(out).toContain("5 次工具调用");
    expect(out).toContain("8.0s");
  });

  it("toolUses=1 → 显示中文工具调用计数", () => {
    const writer = makeCaptureWriter();
    const entries: RuntimeSubAgentUsageEntry[] = [
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
    expect(out).toContain("1 次工具调用");
  });

  it("failed entry → 显示 ⚠ + tokensFmt + 失败标识，并保留工具调用数", () => {
    const writer = makeCaptureWriter();
    const entries: RuntimeSubAgentUsageEntry[] = [
      {
        index: 2,
        description: "查 API",
        tokens: 12_300,
        toolUses: 0,
        durationMs: 3000,
        subId: "fa11ed",
        status: "failed",
      },
    ];
    renderUsageReport(baseBudget, 3, undefined, entries, writer);
    const out = stripAnsi(writer.buffer);
    expect(out).toContain("#2");
    expect(out).toContain("⚠");
    expect(out).toContain("12.3k");
    expect(out).toContain("失败");
    expect(out).toContain("0 次工具调用");
  });

  it("aborted entry → 显示 ⏵ + (aborted) 标识", () => {
    const writer = makeCaptureWriter();
    const entries: RuntimeSubAgentUsageEntry[] = [
      {
        index: 3,
        description: "总结",
        tokens: 2_000,
        toolUses: 0,
        durationMs: 1500,
        subId: "abc123",
        status: "aborted",
      },
    ];
    renderUsageReport(baseBudget, 3, undefined, entries, writer);
    const out = stripAnsi(writer.buffer);
    expect(out).toContain("#3");
    expect(out).toContain("⏵");
    expect(out).toContain("中止");
  });

  it("多 entry → 求和行 Sum 等于各 entry tokens 之和", () => {
    const writer = makeCaptureWriter();
    const entries: RuntimeSubAgentUsageEntry[] = [
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
        toolUses: 0,
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
    expect(out).toContain("子任务总计");
    expect(out).toContain("55.1k");
    expect(out).toContain("3 个");
  });

  it("description 超过 28 字符 → 截断 + 省略号 …", () => {
    const writer = makeCaptureWriter();
    const longDesc = "a".repeat(50);
    const entries: RuntimeSubAgentUsageEntry[] = [
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

  it("子任务拆分分隔线按终端宽度渲染", () => {
    const lines = renderSubtaskUsageLines(
      [
        {
          index: 1,
          description: "调研模块结构",
          tokens: 100,
          toolUses: 1,
          durationMs: 1000,
          status: "succeeded",
        },
      ],
      { columns: 40 },
    );
    const dividerLines = lines.filter((line) => line.includes("─"));
    expect(dividerLines).toHaveLength(2);
    for (const line of dividerLines) {
      expect(stringWidth(line)).toBe(39);
    }
  });

  it("窄屏 usage 条目优先保留编号、状态和成本，所有行不触发终端换行", () => {
    for (const columns of [24, 30, 40]) {
      const lines = renderSubtaskUsageLines(
        [
          {
            index: 1,
            description: "检查超长中文描述不会挤掉关键状态",
            tokens: 123_400,
            toolUses: 12,
            durationMs: 98_000,
            subId: "abcdef",
            status: "failed",
          },
        ],
        { columns },
      );
      const entry = lines.find((line) => stripAnsi(line).includes("#1"));
      expect(entry).toBeDefined();
      expect(stripAnsi(entry!)).toContain("⚠");
      expect(stripAnsi(entry!)).toContain("失败");
      expect(stripAnsi(entry!)).toContain("123.4k");
      for (const line of lines) {
        expect(stringWidth(line)).toBeLessThanOrEqual(columns - 1);
      }
    }
  });

  it("窄屏失败摘要保留核心诊断，必要时拆成两条有界行", () => {
    for (const columns of [24, 30, 40]) {
      const lines = renderSubtaskSummaryLines(
        [
          {
            index: 2,
            description: "读取远端接口并核对返回数据",
            status: "failed",
            tokens: 12_300,
            toolUses: 3,
            durationMs: 4_000,
            subId: "fa11ed",
            errorOrAbortReason: "服务端超时，未取得有效响应",
          },
        ],
        { columns },
      );
      const text = stripAnsi(lines.join("\n"));
      expect(text).toContain("#2");
      expect(text).toContain("⚠");
      expect(text).toContain("失败");
      expect(text).toContain("12.3k");
      expect(text).toContain("原因");
      for (const line of lines) {
        expect(stringWidth(line)).toBeLessThanOrEqual(columns - 1);
      }
    }
  });

  it("24 列混合终态聚合与 usage 总计仍保留全部状态和总成本", () => {
    const displayEntries = [
      {
        index: 1,
        description: "成功任务",
        status: "succeeded" as const,
        tokens: 1_000,
        toolUses: 1,
        durationMs: 1_000,
      },
      {
        index: 2,
        description: "失败任务",
        status: "failed" as const,
        tokens: 2_000,
        toolUses: 1,
        durationMs: 1_000,
        errorOrAbortReason: "超时",
      },
      {
        index: 3,
        description: "中止任务",
        status: "aborted" as const,
        tokens: 3_000,
        toolUses: 1,
        durationMs: 1_000,
      },
    ];
    const summary = renderSubtaskSummaryLines(displayEntries, { columns: 24 });
    const aggregateText = stripAnsi(summary.slice(0, 2).join(" "));
    expect(aggregateText).toContain("1✓");
    expect(aggregateText).toContain("1⚠");
    expect(aggregateText).toContain("1⏵");
    expect(aggregateText).toContain("6.0k");

    const usage = renderSubtaskUsageLines(displayEntries, { columns: 24 });
    const totalLine = usage.find((line) => stripAnsi(line).includes("子任务总计"));
    expect(stripAnsi(totalLine ?? "")).toContain("6.0k");
    for (const line of [...summary, ...usage]) {
      expect(stringWidth(line)).toBeLessThanOrEqual(23);
    }
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
  it("真实 OrchestrationRunner 子 lineage 的多视角进度可见", async () => {
    const writer = makeCaptureWriter();
    const bus = createEventBus<AgentEventMap>({ lineage: "main" });
    const decorator = createRenderSubscribers({ writer });
    const teardown = decorator({ bus, runId: "test", parentBus: null });
    const loaded = loadOrchestrationDefinitionV1(
      createPerspectiveTestDefinition(),
      perspectiveTestCaps,
    );
    if (!loaded.ok) {
      throw new Error(loaded.issues.map((issue) => issue.message).join("; "));
    }
    const nodeExecutor: AgentNodeExecutorV1 = {
      runAgentNode: async (node) => ({
        nodeId: node.id,
        status: "completed",
        output: {
          nodeId: node.id,
          format: "text",
          content: `${node.id}-done`,
        },
        usage: emptyUsage(),
        durationMs: 1,
      }),
    };
    const runner = new OrchestrationRunnerV1({
      bus,
      nodeExecutor,
      createRunId: () => "perspective-ui-test",
    });

    await runner.run({ executable: loaded.executable });

    const out = stripAnsi(writer.buffer);
    expect(out).toContain("多视角评议：3 个节点开始协作");
    expect(out).toContain("交叉吸收中");
    expect(out).toContain("收敛最终版本中");
    teardown();
  });

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

  it("lifecycle warning 渲染为低噪的约定降级提示", async () => {
    const writer = makeCaptureWriter();
    const stop = vi.fn();
    const bus = createEventBus<AgentEventMap>();
    const decorator = createRenderSubscribers({
      writer,
      renderer: { stop } as never,
    });
    const teardown = decorator({ bus, runId: "test", parentBus: null });

    await bus.emit("lifecycle:warning", {
      hookId: "zhixing-guidance",
      phase: "onWindowOpen",
      runtimeId: "runtime-1",
      windowIndex: 1,
      message: "工作场景约定读取失败，已降级为仅全局约定",
    });
    await bus.emit("lifecycle:warning", {
      hookId: "zhixing-guidance",
      phase: "onWindowOpen",
      runtimeId: "runtime-1",
      windowIndex: 2,
      message: "工作场景约定读取失败，已降级为仅全局约定",
    });
    await bus.emit("lifecycle:warning", {
      hookId: "zhixing-guidance",
      phase: "onWindowOpen",
      runtimeId: "runtime-1",
      windowIndex: 3,
      message: "工作场景约定目录不是绝对路径，已跳过场景层",
    });

    expect(stop).toHaveBeenCalledTimes(2);
    expect(writer.segmentBreaks).toBe(2);
    expect(stripAnsi(writer.lines[0] ?? "")).toBe(
      "  ⚠ 约定未完全生效：工作场景约定读取失败，已降级为仅全局约定",
    );
    expect(stripAnsi(writer.lines[1] ?? "")).toBe(
      "  ⚠ 约定未完全生效：工作场景约定目录不是绝对路径，已跳过场景层",
    );

    teardown();
  });
});

const perspectiveTestCaps: OrchestrationSystemCapsV1 = {
  maxNodes: 5,
  maxParallel: 2,
  maxRunMs: 2_000,
  maxNodeTimeoutMs: 1_000,
  maxNodeTurns: 2,
  maxNodeTokens: 500,
  maxContextSnapshotTokens: 500,
  maxInstructionChars: 200,
  maxInputChars: 200,
  maxOutputChars: 200,
  allowedNodeKinds: ["agent"],
  allowedTools: [],
};

function createPerspectiveTestDefinition(): OrchestrationDefinitionV1 {
  const node = (
    id: string,
    dependsOn: readonly string[] = [],
  ): OrchestrationDefinitionV1["nodes"][number] => ({
    id,
    kind: "agent",
    dependsOn: [...dependsOn],
    instruction: `Run ${id}`,
    context: {
      includeRunInput: false,
      includeContextSnapshot: false,
      includeNodeOutputs: "dependencies",
    },
    output: { required: true, format: "text", maxChars: 100 },
    policy: { timeoutMs: 500, maxTurns: 2, maxTokens: 200, tools: [] },
  });
  return {
    version: 1,
    id: PERSPECTIVES_DELIBERATION_DEFINITION_ID,
    title: "Perspective UI test",
    policy: {
      maxParallel: 1,
      maxRunMs: 1_000,
      defaultNodeTimeoutMs: 500,
      defaultMaxTurns: 2,
      defaultMaxTokens: 200,
      allowedTools: [],
      failureMode: "fail_fast",
    },
    input: { required: false, format: "text", maxChars: 100 },
    nodes: [
      node("diverge-1"),
      node("cross-1", ["diverge-1"]),
      node("converge", ["cross-1"]),
    ],
  };
}
