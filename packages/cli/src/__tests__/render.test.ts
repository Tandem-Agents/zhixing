import { describe, expect, it, vi } from "vitest";
import type { AgentEventMap } from "@zhixing/core";
import type { OrchestrationDefinitionV1, OrchestrationSystemCapsV1 } from "@zhixing/core/orchestration";
import { createEventBus, emptyUsage } from "@zhixing/core";
import { loadOrchestrationDefinitionV1 } from "@zhixing/core/orchestration";
import {
  OrchestrationRunnerV1,
  type AgentNodeExecutorV1,
} from "@zhixing/orchestrator/orchestration";
import { createRunEventSubscribers, setupInterruptRendering } from "../render-events.js";
import {
  PERSPECTIVES_DELIBERATION_DEFINITION_ID,
} from "@zhixing/core/conversation/application";
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

describe("createRunEventSubscribers: 工厂注入语义", () => {
  it("真实 OrchestrationRunner 子 lineage 的多视角进度可见", async () => {
    const writer = makeCaptureWriter();
    const bus = createEventBus<AgentEventMap>({ lineage: "main" });
    const decorator = createRunEventSubscribers({ writer });
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
    const decorator = createRunEventSubscribers({ writer });
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
    const decorator = createRunEventSubscribers({
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
