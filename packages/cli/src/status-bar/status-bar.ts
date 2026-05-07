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
  AbortReason,
  AgentEventMap,
  AgentErrorType,
  EventMeta,
  IEventBus,
} from "@zhixing/core";
import type { ScreenController } from "../screen/index.js";
import {
  spinnerFrame,
  COMPLETED_GLYPH,
  formatDuration,
  formatTokens,
  formatAbortReasonShort,
  VERBS,
} from "./verbs.js";
import { tone } from "../tui/style.js";
import { getToolRenderStrategy } from "../tool-render-strategy.js";

/** 状态条节流频率——动画帧 + 计时秒进位都靠这个 tick 推动 */
const TICK_INTERVAL_MS = 250;

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

interface InterruptingState extends RunningState {
  /** watchdog 自动中断的截止时刻（epoch ms）——用于显示倒计时秒数 */
  deadline: number;
}

interface DoneStateBase {
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Done 状态变体——按 AgentRunEndReason 差异化展示，让 status-bar 单点接管所有 turn
 * 终止反馈（取代 renderSummary 在每条 AI 消息底下重复打印）。永驻显示直到下一次
 * agent:run_start 切换到 thinking。
 */
type DoneState =
  | (DoneStateBase & { reason: "completed" })
  | (DoneStateBase & {
      reason: "aborted";
      /** abort 原因——从 interrupt:fired 事件捕获，外部裸 abort 时为 null */
      abortReason: AbortReason | null;
    })
  | (DoneStateBase & {
      reason: "error";
      errorType: AgentErrorType | null;
      errorMessage: string | null;
    })
  | (DoneStateBase & { reason: "max_turns" });

type Phase =
  | { kind: "idle" }
  | ({ kind: "thinking" } & RunningState)
  | ({ kind: "streaming" } & RunningState)
  | ({ kind: "tool" } & RunningState & { toolName: string })
  | ({ kind: "task" } & TaskState)
  | ({ kind: "compacting" } & CompactingState)
  | ({ kind: "retrying" } & RetryingState)
  | ({ kind: "interrupting" } & InterruptingState)
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
  /**
   * 最近一次 interrupt:fired 捕获的 abort 原因——abort 路径上 fired 严格在 run_end
   * 之前发出，run_end 时读取此字段构造 done(aborted) 状态；非 abort 路径不会被读取。
   */
  let lastAbortReason: AbortReason | null = null;

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

  const repaint = (): void => {
    const lines = renderPhase(phase);
    screen.setStatusBar(lines);
    // ticker 仅在"running"状态需要驱动 spinner / 时间累计；idle / done 是静态文本，停 ticker
    if (phase.kind === "idle" || phase.kind === "done") {
      stopTicker();
    }
  };

  // ─── EventBus 订阅 ───

  const offRunStart = eventBus.on("agent:run_start", () => {
    taskCounter = 0;
    lastAbortReason = null;
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

  const offInterruptWarn = eventBus.on("interrupt:warn", (payload) => {
    if (!isPhaseRunning(phase)) return;
    const rs = currentRunning(phase);
    phase = {
      kind: "interrupting",
      startTime: rs.startTime,
      outputTokens: rs.outputTokens,
      inputTokens: rs.inputTokens,
      deadline: Date.now() + (payload.timeoutMs - payload.elapsedMs),
    };
    repaint();
  });

  // abort 路径上 interrupt:fired 严格在 agent:run_end 之前发出——捕获 reason 用于
  // 构造 done(aborted) 状态。非 abort 路径此事件不会触发，lastAbortReason 保持 null。
  const offInterruptFired = eventBus.on("interrupt:fired", (payload) => {
    lastAbortReason = payload.reason;
  });

  const offStreamEventForRecovery = eventBus.on("llm:stream_event", () => {
    // 流恢复活跃 → 退出 interrupting 回到 streaming
    if (phase.kind === "interrupting") {
      phase = transitionTo(phase, "streaming");
      repaint();
    }
  });

  const offRunEnd = eventBus.on("agent:run_end", (payload) => {
    const rs = isPhaseRunning(phase) ? currentRunning(phase) : null;
    const base: DoneStateBase = {
      durationMs: payload.duration,
      inputTokens: payload.usage.inputTokens ?? rs?.inputTokens ?? 0,
      outputTokens: payload.usage.outputTokens ?? rs?.outputTokens ?? 0,
    };
    let doneState: DoneState;
    switch (payload.reason) {
      case "completed":
        doneState = { ...base, reason: "completed" };
        break;
      case "aborted":
        doneState = { ...base, reason: "aborted", abortReason: lastAbortReason };
        break;
      case "error":
        doneState = {
          ...base,
          reason: "error",
          errorType: payload.errorType ?? null,
          errorMessage: payload.error ?? null,
        };
        break;
      case "max_turns":
        doneState = { ...base, reason: "max_turns" };
        break;
    }
    phase = { kind: "done", ...doneState };
    lastAbortReason = null;
    repaint();
    // done 永驻显示——直到下一次 agent:run_start 切换到 thinking。
    // 不再 1.5s linger 后隐藏；status-bar 单点接管所有 turn 终止反馈，让 chrome
    // 永远展示最新 turn 状态（启动后第一次 run 之前 phase=idle，setStatusBar(null)）。
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
      offInterruptWarn();
      offInterruptFired();
      offStreamEventForRecovery();
      offRunEnd();
      stopTicker();
      // done 状态保留显示——status-bar 是终止反馈的单一事实源，dispose 不该清掉它。
      // 下一次 createRenderSubscribers 装载新 status-bar 后，其 agent:run_start handler
      // 会用 thinking 状态自然覆盖。非 done 状态（如异常退出在 thinking）清空避免假状态留屏。
      if (phase.kind !== "done") {
        screen.setStatusBar(null);
      }
    },
  };
}

// ─── 渲染 ───

function renderPhase(phase: Phase): readonly string[] | null {
  if (phase.kind === "idle") return null;
  const now = Date.now();

  if (phase.kind === "done") {
    return [renderDonePhase(phase)];
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
    case "interrupting": {
      mainText = VERBS.interrupting;
      inputTokens = phase.inputTokens;
      outputTokens = phase.outputTokens;
      const remainSec = Math.max(0, Math.ceil((phase.deadline - now) / 1000));
      extra = `${remainSec}s 后自动取消`;
      break;
    }
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

/**
 * Done 状态行渲染——按 AgentRunEndReason 差异化 glyph + 文案，单一事实源接管
 * 所有 turn 终止反馈（completed / aborted / error / max_turns）。
 *
 *   completed  → ✻ 用时 1.6s (↑ 12k ↓ 3k)
 *   aborted    → ⏵ 已中断 (esc) · 1.6s (↑ 12k ↓ 3k)
 *   error      → ✗ 错误 (rate_limit) · 1.6s
 *   max_turns  → ⚠ 达到 turn 上限 · 1.6s (↑ 12k ↓ 3k)
 */
function renderDonePhase(phase: Phase & { kind: "done" }): string {
  const tail = renderTokens(phase.inputTokens, phase.outputTokens);
  const tailSuffix = tail.length > 0 ? ` ${tone.dim(`(${tail})`)}` : "";

  switch (phase.reason) {
    case "completed": {
      const head = `${tone.brand(COMPLETED_GLYPH)} ${VERBS.done(phase.durationMs)}`;
      return `${head}${tailSuffix}`;
    }
    case "aborted": {
      const reasonText = formatAbortReasonShort(phase.abortReason);
      const head = `${tone.dim("⏵")} ${tone.dim(`已中断 (${reasonText}) · ${formatDuration(phase.durationMs)}`)}`;
      return `${head}${tailSuffix}`;
    }
    case "error": {
      const errLabel = phase.errorType ?? "unknown";
      const head = `✗ ${tone.dim(`错误 (${errLabel}) · ${formatDuration(phase.durationMs)}`)}`;
      return head;
    }
    case "max_turns": {
      const head = `⚠ ${tone.dim(`达到 turn 上限 · ${formatDuration(phase.durationMs)}`)}`;
      return `${head}${tailSuffix}`;
    }
  }
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
