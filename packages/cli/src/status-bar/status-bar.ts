/**
 * 状态条——AI 思考 / 回复 / 工具 / 完成等动态状态的统一展示。
 *
 * 输入：EventBus 订阅（agent / llm / tool / context / retry）
 * 输出：通过 ScreenController.setStatusBar 把渲染好的行投递到屏幕状态条区
 *
 * 状态机：
 *   idle ──▶ thinking ─[stream]─▶ streaming ─[tool_start]─▶ tool ─[tool_end]─▶ streaming
 *                                                ↑ ↓
 *                                       (子 agent Task 是分发型工具，由 lineage="main" 的
 *                                        tool_start 切到 task；子 bus 的 tool 事件更新内层 subTool)
 *                          [compact_start]─▶ compacting ─[compact_end]─▶ streaming
 *                          [retry_attempt]─▶ retrying ──[next stream]──▶ streaming
 *                          [run_end]──▶ done ──[next run_start]──▶ thinking
 *
 * 计时与 token：
 *   - 计时：以 agent:run_start 时刻为锚，每 ~500ms 重画刷新秒数
 *   - 输出 token 流式估算：每个 stream chunk 字符长度求和（粗略，turn 末由 llm:request_end.usage 校准为真值）
 *   - 输入 token：llm:request_end.usage 给出真值，turn 中括号显示
 *
 * 与 sub-agent-status 的整合：原 setupSubAgentStatus 用 `\r` 单行刷新主 Task 工具调用的
 * `[Task#N: desc] <最近工具>`，与此模块职责完全重叠。Phase 4 后整合于此，按 lineage 区分主/子
 * bus 事件并在 task 状态下嵌套显示。
 */

import type {
  AgentEventMap,
  EventMeta,
  IEventBus,
} from "@zhixing/core";
import type { ScreenController } from "../screen/index.js";
import {
  spinnerFrame,
  COMPLETED_GLYPH,
  formatDuration,
  formatTokens,
  VERBS,
} from "./verbs.js";
import { tone } from "../tui/style.js";
import { getToolRenderStrategy } from "../tool-render-strategy.js";

/** 状态条节流频率——动画帧 + 计时秒进位都靠这个 tick 推动 */
const TICK_INTERVAL_MS = 250;

/** 完成态显示后停留多久才隐藏（让用户看清最终时长 / token） */
const DONE_LINGER_MS = 1500;

interface RunningState {
  startTime: number;
  outputTokens: number;
  inputTokens: number;
}

interface TaskState extends RunningState {
  taskN: number;
  taskDesc: string;
  /** 已关联到当前 Task 的子 bus lineage */
  subLineage: string | null;
  /** 子 agent 最近一次工具调用名 */
  subToolName: string | null;
}

interface CompactingState extends RunningState {
  tokensBefore: number;
}

interface RetryingState extends RunningState {
  attempt: number;
  maxRetries: number;
  errorType: string;
}

interface DoneState {
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  shownAt: number;
}

type Phase =
  | { kind: "idle" }
  | ({ kind: "thinking" } & RunningState)
  | ({ kind: "streaming" } & RunningState)
  | ({ kind: "tool" } & RunningState & { toolName: string })
  | ({ kind: "task" } & TaskState)
  | ({ kind: "compacting" } & CompactingState)
  | ({ kind: "retrying" } & RetryingState)
  | ({ kind: "done" } & DoneState);

export interface StatusBarHandle {
  dispose(): void;
}

interface CreateStatusBarOptions {
  readonly screen: ScreenController;
  readonly eventBus: IEventBus<AgentEventMap>;
}

export function createStatusBar(options: CreateStatusBarOptions): StatusBarHandle {
  const { screen, eventBus } = options;
  let phase: Phase = { kind: "idle" };
  let taskCounter = 0;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let doneTimer: ReturnType<typeof setTimeout> | null = null;

  const isMainLineage = (meta?: EventMeta): boolean =>
    meta?.lineage === "main";
  const isSubLineage = (meta?: EventMeta): boolean =>
    typeof meta?.lineage === "string" && meta.lineage.startsWith("main/sub-");

  const ensureTicker = (): void => {
    if (ticker !== null) return;
    ticker = setInterval(() => repaint(), TICK_INTERVAL_MS);
  };

  const stopTicker = (): void => {
    if (ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  };

  const clearDoneTimer = (): void => {
    if (doneTimer !== null) {
      clearTimeout(doneTimer);
      doneTimer = null;
    }
  };

  const repaint = (): void => {
    const lines = renderPhase(phase);
    screen.setStatusBar(lines);
    if (
      phase.kind === "idle" ||
      (phase.kind === "done" && doneTimer === null)
    ) {
      stopTicker();
    }
  };

  // ─── EventBus 订阅 ───

  const offRunStart = eventBus.on("agent:run_start", () => {
    clearDoneTimer();
    taskCounter = 0;
    phase = makeRunning("thinking", Date.now());
    ensureTicker();
    repaint();
  });

  const offStreamEvent = eventBus.on("llm:stream_event", (event) => {
    if (!isPhaseRunning(phase)) return;
    const charCount = extractStreamChars(event);
    if (charCount > 0) {
      const updated = withRunning(phase, (rs) => ({
        ...rs,
        outputTokens: rs.outputTokens + estimateTokens(charCount),
      }));
      phase = updated;
      // streaming 状态从 thinking 切换：第一个 stream chunk 到达
      if (phase.kind === "thinking") {
        phase = transitionTo(phase, "streaming");
      }
    }
  });

  const offRequestEnd = eventBus.on("llm:request_end", (event) => {
    if (!isPhaseRunning(phase)) return;
    // 用真实 usage 校准 token 估算
    phase = withRunning(phase, (rs) => ({
      ...rs,
      outputTokens: event.usage.outputTokens ?? rs.outputTokens,
      inputTokens: event.usage.inputTokens ?? rs.inputTokens,
    }));
  });

  const offToolStart = eventBus.on(
    "tool:call_start",
    (payload, meta) => {
      // 主 bus 派发型工具（Task）→ 切 task 状态，准备承接子 bus 事件
      if (
        isMainLineage(meta) &&
        getToolRenderStrategy(payload.name) === "sub-agent-status"
      ) {
        if (!isPhaseRunning(phase)) return;
        const desc = extractTaskDescription(payload.input);
        taskCounter += 1;
        const rs = currentRunning(phase);
        phase = {
          kind: "task",
          startTime: rs.startTime,
          outputTokens: rs.outputTokens,
          inputTokens: rs.inputTokens,
          taskN: taskCounter,
          taskDesc: desc,
          subLineage: null,
          subToolName: null,
        };
        repaint();
        return;
      }
      // 主 bus 普通工具 → 切 tool 状态
      if (isMainLineage(meta)) {
        if (!isPhaseRunning(phase)) return;
        const rs = currentRunning(phase);
        phase = {
          kind: "tool",
          startTime: rs.startTime,
          outputTokens: rs.outputTokens,
          inputTokens: rs.inputTokens,
          toolName: payload.name,
        };
        repaint();
        return;
      }
      // 子 bus（Task 内部工具）→ 当前 task 状态下更新 subToolName
      if (isSubLineage(meta) && phase.kind === "task") {
        if (phase.subLineage === null) {
          phase = { ...phase, subLineage: meta!.lineage!, subToolName: payload.name };
        } else if (meta!.lineage === phase.subLineage) {
          phase = { ...phase, subToolName: payload.name };
        }
        repaint();
      }
    },
  );

  const offToolEnd = eventBus.on(
    "tool:call_end",
    (payload, meta) => {
      // 主 bus 派发型工具完成 → 回 streaming
      if (
        isMainLineage(meta) &&
        getToolRenderStrategy(payload.name) === "sub-agent-status" &&
        phase.kind === "task"
      ) {
        const next = transitionTo(phase, "streaming");
        phase = next;
        repaint();
        return;
      }
      // 主 bus 普通工具完成 → 回 streaming
      if (isMainLineage(meta) && phase.kind === "tool") {
        phase = transitionTo(phase, "streaming");
        repaint();
        return;
      }
      // 子 bus 工具完成 → 清除 subToolName，subLineage 保留等下个 sub tool
      if (
        isSubLineage(meta) &&
        phase.kind === "task" &&
        meta!.lineage === phase.subLineage
      ) {
        phase = { ...phase, subToolName: null };
        repaint();
      }
    },
  );

  const offCompactStart = eventBus.on(
    "context:compact_start",
    (payload) => {
      if (!isPhaseRunning(phase)) return;
      const rs = currentRunning(phase);
      phase = {
        kind: "compacting",
        startTime: rs.startTime,
        outputTokens: rs.outputTokens,
        inputTokens: rs.inputTokens,
        tokensBefore: payload.tokensBefore,
      };
      repaint();
    },
  );

  const offCompactEnd = eventBus.on("context:compact_end", () => {
    if (phase.kind === "compacting") {
      phase = transitionTo(phase, "streaming");
      repaint();
    }
  });

  const offRetryAttempt = eventBus.on(
    "retry:attempt",
    (payload) => {
      if (!isPhaseRunning(phase)) return;
      const rs = currentRunning(phase);
      phase = {
        kind: "retrying",
        startTime: rs.startTime,
        outputTokens: rs.outputTokens,
        inputTokens: rs.inputTokens,
        attempt: payload.attempt,
        maxRetries: payload.maxRetries,
        errorType: payload.errorType,
      };
      repaint();
    },
  );

  const offRetrySuccess = eventBus.on("retry:success", () => {
    if (phase.kind === "retrying") {
      phase = transitionTo(phase, "streaming");
      repaint();
    }
  });

  const offRunEnd = eventBus.on("agent:run_end", (payload) => {
    const rs = isPhaseRunning(phase) ? currentRunning(phase) : null;
    phase = {
      kind: "done",
      durationMs: payload.duration,
      inputTokens:
        payload.usage.inputTokens ?? rs?.inputTokens ?? 0,
      outputTokens:
        payload.usage.outputTokens ?? rs?.outputTokens ?? 0,
      shownAt: Date.now(),
    };
    repaint();
    clearDoneTimer();
    doneTimer = setTimeout(() => {
      doneTimer = null;
      phase = { kind: "idle" };
      repaint();
    }, DONE_LINGER_MS);
  });

  return {
    dispose(): void {
      offRunStart();
      offStreamEvent();
      offRequestEnd();
      offToolStart();
      offToolEnd();
      offCompactStart();
      offCompactEnd();
      offRetryAttempt();
      offRetrySuccess();
      offRunEnd();
      stopTicker();
      clearDoneTimer();
      screen.setStatusBar(null);
    },
  };
}

// ─── 渲染 ───

function renderPhase(phase: Phase): readonly string[] | null {
  if (phase.kind === "idle") return null;
  const now = Date.now();

  if (phase.kind === "done") {
    const head = `${tone.brand(COMPLETED_GLYPH)} ${VERBS.done(phase.durationMs)}`;
    const tail = renderTokens(phase.inputTokens, phase.outputTokens);
    return [tail.length > 0 ? `${head} ${tone.dim(`(${tail})`)}` : head];
  }

  const spinner = tone.brand(spinnerFrame(now));
  const elapsed = formatDuration(now - phaseStartTime(phase));

  let mainText: string;
  let extra: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  switch (phase.kind) {
    case "thinking":
      mainText = VERBS.thinking;
      inputTokens = phase.inputTokens;
      outputTokens = phase.outputTokens;
      break;
    case "streaming":
      mainText = VERBS.streaming;
      inputTokens = phase.inputTokens;
      outputTokens = phase.outputTokens;
      break;
    case "tool":
      mainText = VERBS.toolCalling(phase.toolName);
      inputTokens = phase.inputTokens;
      outputTokens = phase.outputTokens;
      extra = "等待结果";
      break;
    case "task":
      mainText = VERBS.task(phase.taskN, phase.taskDesc);
      inputTokens = phase.inputTokens;
      outputTokens = phase.outputTokens;
      if (phase.subToolName) extra = VERBS.toolCalling(phase.subToolName);
      break;
    case "compacting":
      mainText = VERBS.compacting;
      inputTokens = phase.inputTokens;
      outputTokens = phase.outputTokens;
      break;
    case "retrying":
      mainText = VERBS.retrying;
      inputTokens = phase.inputTokens;
      outputTokens = phase.outputTokens;
      extra = `第 ${phase.attempt}/${phase.maxRetries} 次`;
      break;
  }

  const parts: string[] = [elapsed];
  const tokenPart = renderTokens(inputTokens, outputTokens);
  if (tokenPart.length > 0) parts.push(tokenPart);
  if (extra) parts.push(extra);
  const bracket = tone.dim(`(${parts.join(" · ")})`);

  return [`${spinner} ${mainText} ${bracket}`];
}

function renderTokens(inputTokens: number, outputTokens: number): string {
  const segs: string[] = [];
  if (inputTokens > 0) segs.push(`↑ ${formatTokens(inputTokens)}`);
  if (outputTokens > 0) segs.push(`↓ ${formatTokens(outputTokens)}`);
  return segs.join(" ");
}

// ─── 状态机 helpers ───

function makeRunning(
  kind: "thinking" | "streaming",
  startTime: number,
): Phase {
  return {
    kind,
    startTime,
    outputTokens: 0,
    inputTokens: 0,
  };
}

function isPhaseRunning(
  phase: Phase,
): phase is Exclude<Phase, { kind: "idle" } | { kind: "done" }> {
  return phase.kind !== "idle" && phase.kind !== "done";
}

function currentRunning(
  phase: Exclude<Phase, { kind: "idle" } | { kind: "done" }>,
): RunningState {
  return {
    startTime: phase.startTime,
    outputTokens: phase.outputTokens,
    inputTokens: phase.inputTokens,
  };
}

function withRunning(
  phase: Phase,
  patch: (rs: RunningState) => RunningState,
): Phase {
  if (!isPhaseRunning(phase)) return phase;
  const rs = patch(currentRunning(phase));
  return { ...phase, ...rs };
}

function transitionTo(
  phase: Exclude<Phase, { kind: "idle" } | { kind: "done" }>,
  kind: "streaming",
): Phase {
  const rs = currentRunning(phase);
  return { kind, ...rs };
}

function phaseStartTime(
  phase: Exclude<Phase, { kind: "idle" } | { kind: "done" }>,
): number {
  return phase.startTime;
}

// ─── 数据估算 ───

/**
 * 从 stream event 提取本帧新增字符数（粗略估算 token）。
 * StreamEvent 是 discriminated union，按 type 字段缩窄安全提取。
 */
function extractStreamChars(event: AgentEventMap["llm:stream_event"]): number {
  if (event.type === "text_delta") return event.text.length;
  if (event.type === "thinking_delta") return event.thinking.length;
  if (event.type === "tool_call_delta") return event.argsFragment.length;
  return 0;
}

/** 字符数估算 token——4 chars ≈ 1 token (英文)；CJK 1:1，取折中 2.5。 */
function estimateTokens(charCount: number): number {
  return Math.max(1, Math.round(charCount / 2.5));
}

/** 从 Task 工具 input 提取 description（与 sub-agent-status 兼容） */
function extractTaskDescription(input: Record<string, unknown>): string {
  const raw = input["description"];
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return "(未命名)";
}
