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
 *        [segment:transition_start]─▶ compacting ─[new_started | transition_failed]─▶ streaming
 *                          [retry_attempt]─▶ retrying ──[next stream]──▶ streaming
 *                          [run_end]──▶ done ──[next run_start]──▶ thinking
 *
 * 计时与 token：
 *   - 计时：以 agent:run_start 时刻为锚，每 ~500ms 重画刷新秒数
 *   - 输出 token 流式估算：每个 stream chunk 经 core CJK 估算器折算累加（过程值，
 *     turn 末由 llm:request_end.usage 覆盖为真值）
 *   - 输入 token：llm:request_end.usage 经 getTotalInputTokens 取规范全量口径
 *     累加（含 cache 命中部分），turn 中括号显示
 *
 * 与 sub-agent-status 的整合：原 setupSubAgentStatus 用 `\r` 单行刷新主 Task 工具调用的
 * `[Task#N: desc] <最近工具>`，与此模块职责完全重叠。后整合于此，按 lineage 区分主/子
 * bus 事件并在 task 状态下嵌套显示。
 */

import type {
  AbortReason,
  AgentEventMap,
  AgentErrorType,
  EventMeta,
  IEventBus,
} from "@zhixing/core";
import { getTotalInputTokens, estimateTextTokensRaw } from "@zhixing/core";
import type { ScreenController } from "../screen/index.js";
import {
  spinnerFrame,
  COMPLETED_GLYPH,
  formatDuration,
  formatTokens,
  formatAbortReasonShort,
  VERBS,
} from "./verbs.js";
import { tone, layout, getTerminalWidth } from "../tui/style.js";
import { clampLine, stringWidth } from "../tui/line-width.js";
import { getToolRenderStrategy } from "../tool-render-strategy.js";
import { ANCHOR_SUB_AGENT } from "../output/speaker-state.js";

/** 状态条节流频率——动画帧 + 计时秒进位都靠这个 tick 推动 */
const TICK_INTERVAL_MS = 250;

/**
 * 单轮（agent run）累加的 token 状态——单一 user prompt → agent 终止之间。
 *
 * **语义切片（committed vs streaming）**：
 *   - `committedInput` / `committedOutput` —— 已完成 LLM 请求的累加值，每次
 *     `llm:request_end` 时把该次 usage 累加进来；request 内的流式估算不进 committed
 *   - `streamingOutput` —— 当前进行中 LLM request 的流式 chunk 字符估算，
 *     `request_end` 触发时清零（真值已 committed）
 *
 * **两段切分的根因**：LLM provider 的 stream chunk 没有 token 真值，仅在 request_end
 *   时给出 cumulative usage。流式期间用字符估算填补"思考中→请求未完"的过程感，
 *   request_end 时换成真值——直接覆盖会丢失"前几次 LLM 请求的累加"，先 commit 后清零
 *   保证跨多 LLM 请求的累加正确。
 *
 * **显示规则**：
 *   - input  = `committedInput`                          （流式期间没有 input 增量）
 *   - output = `committedOutput + streamingOutput`        （流式段叠加在已完成段上）
 *
 * **跨轮重置**：每次 `agent:run_start` 通过 `makeRunning` 重置全部为 0；status-bar
 *   实例本身也由 orchestrator 在每次 run() 开始通过 decorateRunBus 重建，
 *   双重保证不会跨用户输入轮次累加。
 */
interface RunningState {
  startTime: number;
  committedInput: number;
  committedOutput: number;
  streamingOutput: number;
}

type TaskLifecycleStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "aborted";

interface TaskState {
  toolCallId: string;
  taskN: number;
  taskDesc: string;
  status: TaskLifecycleStatus;
  parentEnded: boolean;
  subLineage: string | null;
  subToolName: string | null;
}

interface TaskAggregateState extends RunningState {
  focusToolCallId: string | null;
  totalCount: number;
  activeCount: number;
  focusTaskN: number | null;
  focusTaskDesc: string | null;
  focusSubToolName: string | null;
  completedCount: number;
  failedCount: number;
  abortedCount: number;
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

/**
 * Done 状态——只保留时长。token 信息不在结束态展示（用户视角"任务已结束、
 * 过程数据无意义"），过程中的累加 token 已在 running 阶段持续展示。
 */
interface DoneStateBase {
  durationMs: number;
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
  | ({ kind: "task" } & TaskAggregateState)
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
  const activeTasks = new Map<string, TaskState>();
  const childLineageToTaskId = new Map<string, string>();
  let ticker: ReturnType<typeof setInterval> | null = null;
  /**
   * 最近一次 interrupt:fired 捕获的 abort 原因——abort 路径上 fired 严格在 run_end
   * 之前发出，run_end 时读取此字段构造 done(aborted) 状态；非 abort 路径不会被读取。
   */
  let lastAbortReason: AbortReason | null = null;

  const isMainLineage = (meta?: EventMeta): boolean =>
    meta?.lineage === undefined || meta.lineage === "main";
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

  /**
   * 标记 ScreenController 是否处于 suspended（alt UI 嵌入期间）——为 true 时
   * status-bar 暂停 ticker 并跳过 setStatusBar 调用，避免 alt UI 期间状态条
   * paint 任务在 ScreenController 暂存队列累积 + 资源浪费（chrome 已让位看不到）。
   */
  let chromeSuspended = false;

  const repaint = (): void => {
    if (chromeSuspended) return;
    const lines = renderPhase(phase);
    screen.setStatusBar(lines);
    // ticker 仅在"running"状态需要驱动 spinner / 时间累计；idle / done 是静态文本，停 ticker
    if (phase.kind === "idle" || phase.kind === "done") {
      stopTicker();
    }
  };

  /**
   * 订阅 ScreenController suspend 状态变化——alt UI 进入时停 ticker，离开时按
   * 当前 phase 决定是否恢复 ticker。
   *
   * 状态字段（phase / lastAbortReason 等）在 alt UI 期间继续被 EventBus 事件
   * 驱动更新——只是不写屏。alt UI 退出 resume 后下一次 ensureTicker / repaint
   * 用最新 phase 自然显示当前态。
   */
  const offSuspendChange = screen.onSuspendChange((suspended) => {
    chromeSuspended = suspended;
    if (suspended) {
      stopTicker();
    } else if (isPhaseRunning(phase)) {
      ensureTicker();
      repaint();
    }
  });

  const currentTaskFocus = (): string | null => {
    if (phase.kind === "task" && phase.focusToolCallId) {
      const current = activeTasks.get(phase.focusToolCallId);
      if (current?.status === "running") return phase.focusToolCallId;
    }
    for (const task of activeTasks.values()) {
      if (task.status === "running") return task.toolCallId;
    }
    return activeTasks.keys().next().value ?? null;
  };

  const toTaskPhase = (
    rs: RunningState,
    focusToolCallId: string | null,
  ): Phase => {
    const counts = deriveTaskCounts(activeTasks.values());
    const preferred = focusToolCallId ? activeTasks.get(focusToolCallId) : undefined;
    const focus = preferred?.status === "running"
      ? preferred.toolCallId
      : currentTaskFocus();
    const focusTask = focus ? activeTasks.get(focus) : undefined;
    return {
      kind: "task",
      ...rs,
      ...counts,
      focusToolCallId: focus,
      totalCount: activeTasks.size,
      focusTaskN: focusTask?.taskN ?? null,
      focusTaskDesc: focusTask?.taskDesc ?? null,
      focusSubToolName: focusTask?.subToolName ?? null,
    };
  };

  const taskIdForChildLineage = (lineage: string): string | null => {
    const exact = childLineageToTaskId.get(lineage);
    if (exact) return exact;
    for (const [childLineage, taskId] of childLineageToTaskId) {
      if (lineage === childLineage || lineage.startsWith(`${childLineage}/`)) {
        return taskId;
      }
    }
    return null;
  };

  // ─── EventBus 订阅 ───

  const offRunStart = eventBus.on("agent:run_start", (_payload, meta) => {
    if (!isMainLineage(meta)) return;
    taskCounter = 0;
    activeTasks.clear();
    childLineageToTaskId.clear();
    lastAbortReason = null;
    phase = makeRunning("thinking", Date.now());
    ensureTicker();
    repaint();
  });

  const offStreamEvent = eventBus.on("llm:stream_event", (event, meta) => {
    if (!isMainLineage(meta)) return;
    if (!isPhaseRunning(phase)) return;
    const tokenEstimate = estimateStreamTokens(event);
    if (tokenEstimate > 0) {
      // 流式估算累加进 streamingOutput——request_end 时会清零并 commit 真值
      const updated = withRunning(phase, (rs) => ({
        ...rs,
        streamingOutput: rs.streamingOutput + tokenEstimate,
      }));
      phase = updated;
      // streaming 状态从 thinking 切换：第一个 stream chunk 到达
      if (phase.kind === "thinking") {
        phase = transitionTo(phase, "streaming");
      }
      // 立即 repaint——LLM stream chunk 高频但每次 setStatusBar < 1ms，立即可见胜过
      // 等 250ms ticker（用户体感：短 turn 内根本来不及看到 token 累加）。
      repaint();
    }
  });

  const offRequestEnd = eventBus.on("llm:request_end", (event, meta) => {
    if (!isPhaseRunning(phase)) return;
    const mainLineage = isMainLineage(meta);
    // 一次 LLM 请求结束：把本次 usage 累加进 committed，清零流式估算（真值已 commit）。
    // 累加（不是覆盖）保证一轮内多次 LLM 请求（含工具调用循环）的 token 不丢失。
    //
    // input 用 getTotalInputTokens 取规范全量口径（含 cache 命中部分）——
    // Anthropic 的 inputTokens 排除 cache 会系统性低估本 run 真实输入流量；
    // OpenAI 兼容族 totalInputTokens 不设，fallback 回 inputTokens（prompt_tokens
    // 本就是全量）与改前逐字节相同。anchor / 校准仍读 vendor 原值，互不影响。
    phase = withRunning(phase, (rs) => ({
      ...rs,
      committedInput: rs.committedInput + getTotalInputTokens(event.usage),
      committedOutput: rs.committedOutput + (event.usage.outputTokens ?? 0),
      streamingOutput: mainLineage ? 0 : rs.streamingOutput,
    }));
    // 立即 repaint——真值落地是 token 显示的关键节点（input 第一次出现 / 多请求累加）
    repaint();
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
        activeTasks.set(payload.id, {
          toolCallId: payload.id,
          taskN: taskCounter,
          taskDesc: desc,
          status: "running",
          parentEnded: false,
          subLineage: null,
          subToolName: null,
        });
        phase = toTaskPhase(currentRunning(phase), payload.id);
        repaint();
        return;
      }
      // 主 bus 普通工具 → 切 tool 状态
      if (isMainLineage(meta)) {
        if (!isPhaseRunning(phase)) return;
        if (activeTasks.size > 0) {
          phase = toTaskPhase(currentRunning(phase), currentTaskFocus());
          repaint();
          return;
        }
        const rs = currentRunning(phase);
        phase = {
          kind: "tool",
          ...rs,
          toolName: payload.name,
        };
        repaint();
        return;
      }
      // 子 bus（Task 内部工具）→ 通过 child lineage 反查父 Task
      if (isSubLineage(meta) && isPhaseRunning(phase)) {
        const taskId = taskIdForChildLineage(meta!.lineage!);
        if (!taskId) return;
        const task = activeTasks.get(taskId);
        if (!task || task.status !== "running") return;
        activeTasks.set(taskId, {
          ...task,
          subLineage: meta!.lineage!,
          subToolName: payload.name,
        });
        phase = toTaskPhase(currentRunning(phase), taskId);
        repaint();
      }
    },
  );

  const offChildStart = eventBus.on("tool:child_start", (payload) => {
    const task = activeTasks.get(payload.parentToolCallId);
    if (!task || task.status !== "running" || !isPhaseRunning(phase)) return;
    childLineageToTaskId.set(payload.childLineage, payload.parentToolCallId);
    activeTasks.set(payload.parentToolCallId, {
      ...task,
      subLineage: payload.childLineage,
    });
    phase = toTaskPhase(currentRunning(phase), payload.parentToolCallId);
    repaint();
  });

  const offChildEnd = eventBus.on("tool:child_end", (payload) => {
    childLineageToTaskId.delete(payload.childLineage);
    const task = activeTasks.get(payload.parentToolCallId);
    if (!task || task.status !== "running" || !isPhaseRunning(phase)) return;
    activeTasks.set(payload.parentToolCallId, {
      ...task,
      status: payload.status,
      subLineage: null,
      subToolName: null,
    });
    phase = toTaskPhase(currentRunning(phase), currentTaskFocus());
    repaint();
  });

  const offToolEnd = eventBus.on(
    "tool:call_end",
    (payload, meta) => {
      // 主 bus 派发型工具完成 → 回 streaming
      if (
        isMainLineage(meta) &&
        getToolRenderStrategy(payload.name) === "sub-agent-status"
      ) {
        if (!isPhaseRunning(phase)) return;
        const task = activeTasks.get(payload.id);
        if (!task) return;
        if (task.subLineage) childLineageToTaskId.delete(task.subLineage);
        activeTasks.set(payload.id, {
          ...task,
          status:
            task.status === "running"
              ? payload.success === false
                ? "failed"
                : "succeeded"
              : task.status,
          parentEnded: true,
          subLineage: null,
          subToolName: null,
        });
        if ([...activeTasks.values()].some((entry) => !entry.parentEnded)) {
          phase = toTaskPhase(currentRunning(phase), currentTaskFocus());
        } else {
          activeTasks.clear();
          childLineageToTaskId.clear();
          phase = transitionTo(phase, "streaming");
        }
        repaint();
        return;
      }
      // 主 bus 普通工具完成 → 回 streaming
      if (isMainLineage(meta) && phase.kind === "tool") {
        phase = transitionTo(phase, "streaming");
        repaint();
        return;
      }
      if (isMainLineage(meta) && isPhaseRunning(phase) && activeTasks.size > 0) {
        phase = toTaskPhase(currentRunning(phase), currentTaskFocus());
        repaint();
        return;
      }
      // 子 bus 工具完成 → 清除 subToolName，subLineage 保留等下个 sub tool
      if (isSubLineage(meta) && isPhaseRunning(phase)) {
        const taskId = taskIdForChildLineage(meta!.lineage!);
        if (!taskId) return;
        const task = activeTasks.get(taskId);
        if (!task || task.status !== "running") return;
        activeTasks.set(taskId, { ...task, subToolName: null });
        phase = toTaskPhase(currentRunning(phase), taskId);
        repaint();
      }
    },
  );

  const offCompactStart = eventBus.on(
    "segment:transition_start",
    (payload, meta) => {
      if (!isMainLineage(meta)) return;
      if (!isPhaseRunning(phase)) return;
      const rs = currentRunning(phase);
      phase = {
        kind: "compacting",
        ...rs,
        tokensBefore: payload.currentTokens,
      };
      repaint();
    },
  );

  // 成功（new_started）与失败（transition_failed）都收束相位 —— 失败不阻塞对话
  const offCompactEnd = eventBus.on("segment:new_started", (_payload, meta) => {
    if (!isMainLineage(meta)) return;
    if (phase.kind === "compacting") {
      phase = transitionTo(phase, "streaming");
      repaint();
    }
  });
  const offCompactFailed = eventBus.on("segment:transition_failed", (_payload, meta) => {
    if (!isMainLineage(meta)) return;
    if (phase.kind === "compacting") {
      phase = transitionTo(phase, "streaming");
      repaint();
    }
  });

  const offRetryAttempt = eventBus.on(
    "retry:attempt",
    (payload, meta) => {
      if (!isMainLineage(meta)) return;
      if (!isPhaseRunning(phase)) return;
      const rs = currentRunning(phase);
      phase = {
        kind: "retrying",
        ...rs,
        attempt: payload.attempt,
        maxRetries: payload.maxRetries,
        errorType: payload.errorType,
      };
      repaint();
    },
  );

  const offRetrySuccess = eventBus.on("retry:success", (_payload, meta) => {
    if (!isMainLineage(meta)) return;
    if (phase.kind === "retrying") {
      phase = transitionTo(phase, "streaming");
      repaint();
    }
  });

  const offInterruptWarn = eventBus.on("interrupt:warn", (payload, meta) => {
    if (!isMainLineage(meta)) return;
    if (!isPhaseRunning(phase)) return;
    const rs = currentRunning(phase);
    phase = {
      kind: "interrupting",
      ...rs,
      deadline: Date.now() + (payload.timeoutMs - payload.elapsedMs),
    };
    repaint();
  });

  // abort 路径上 interrupt:fired 严格在 agent:run_end 之前发出——捕获 reason 用于
  // 构造 done(aborted) 状态。非 abort 路径此事件不会触发，lastAbortReason 保持 null。
  const offInterruptFired = eventBus.on("interrupt:fired", (payload, meta) => {
    if (!isMainLineage(meta)) return;
    lastAbortReason = payload.reason;
  });

  const offStreamEventForRecovery = eventBus.on("llm:stream_event", (_payload, meta) => {
    if (!isMainLineage(meta)) return;
    // 流恢复活跃 → 退出 interrupting 回到 streaming
    if (phase.kind === "interrupting") {
      phase = transitionTo(phase, "streaming");
      repaint();
    }
  });

  const offRunEnd = eventBus.on("agent:run_end", (payload, meta) => {
    if (!isMainLineage(meta)) return;
    activeTasks.clear();
    childLineageToTaskId.clear();
    const base: DoneStateBase = {
      durationMs: payload.duration,
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
      offChildStart();
      offChildEnd();
      offToolEnd();
      offCompactStart();
      offCompactEnd();
      offCompactFailed();
      offRetryAttempt();
      offRetrySuccess();
      offInterruptWarn();
      offInterruptFired();
      offStreamEventForRecovery();
      offRunEnd();
      offSuspendChange();
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

/**
 * 渲染状态条行——单一注入点：raw 业务逻辑算出无 indent 的行，本函数统一加
 * `layout.contentPrefix` 起首前缀。
 *
 * 视觉契约：状态条行与 AI 行 (`  ◆ ...`) 等其它内容左边距对齐到统一列；chrome
 * 盒子内的内容由 chrome 自管 padding，与此无关。指引在 `tui/style.ts:layout`。
 */
function renderPhase(phase: Phase): readonly string[] | null {
  const columns = getTerminalWidth();
  const rawLines = renderPhaseRaw(phase, Math.max(1, columns - 1));
  if (rawLines === null) return null;
  return rawLines.map((line) =>
    clampLine(`${layout.contentPrefix}${line}`, Math.max(1, columns - 1)),
  );
}

/** 渲染状态条 raw 行——不含 indent 前缀，由 renderPhase 装饰注入。 */
function renderPhaseRaw(phase: Phase, lineBudget: number): readonly string[] | null {
  if (phase.kind === "idle") return null;
  const now = Date.now();

  if (phase.kind === "done") {
    return [renderDonePhase(phase)];
  }

  const spinner = tone.brand(spinnerFrame(now));
  const elapsed = formatDuration(now - phaseStartTime(phase));

  if (phase.kind === "task") {
    return renderTaskPhase(phase, spinner, elapsed, lineBudget);
  }

  let mainText: string;
  let extra: string | null = null;

  switch (phase.kind) {
    case "thinking":
      mainText = VERBS.thinking;
      break;
    case "streaming":
      mainText = VERBS.streaming;
      break;
    case "tool":
      mainText = VERBS.toolCalling(phase.toolName);
      extra = "等待结果";
      break;
    case "compacting":
      mainText = VERBS.compacting;
      break;
    case "retrying":
      mainText = VERBS.retrying;
      extra = `第 ${phase.attempt}/${phase.maxRetries} 次`;
      break;
    case "interrupting": {
      mainText = VERBS.interrupting;
      const remainSec = Math.max(0, Math.ceil((phase.deadline - now) / 1000));
      extra = `${remainSec}s 后自动取消`;
      break;
    }
  }

  // 显示 token：input = committedInput；output = committedOutput + streamingOutput。
  // 流式段叠加在已 commit 段上——保证从 stream chunk 到 request_end 的过渡视觉
  // 单调递增，没有"骤减"或"覆盖"。
  const inputTokens = phase.committedInput;
  const outputTokens = phase.committedOutput + phase.streamingOutput;

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

function renderTaskPhase(
  phase: Phase & { kind: "task" },
  spinner: string,
  elapsed: string,
  lineBudget: number,
): readonly string[] {
  const inputTokens = phase.committedInput;
  const outputTokens = phase.committedOutput + phase.streamingOutput;
  const anchorParts = [elapsed];
  const tokenPart = renderTokens(inputTokens, outputTokens);
  if (tokenPart.length > 0) anchorParts.push(tokenPart);
  const anchor = `${spinner} 子任务中 ${tone.dim(`(${anchorParts.join(" · ")})`)}`;
  return [renderTaskDetail(phase, lineBudget), anchor];
}

function renderTaskDetail(
  phase: Phase & { kind: "task" },
  lineBudget: number,
): string {
  const contentBudget = Math.max(1, lineBudget - stringWidth(layout.contentPrefix));
  const counts = [
    phase.activeCount > 0 ? `${phase.activeCount} 运行` : null,
    phase.completedCount > 0 ? `${phase.completedCount} 完成` : null,
    phase.failedCount > 0 ? `${phase.failedCount} 失败` : null,
    phase.abortedCount > 0 ? `${phase.abortedCount} 中止` : null,
  ].filter((part): part is string => part !== null);
  const prefix = `${tone.dim(ANCHOR_SUB_AGENT)} ${phase.totalCount} 个子任务${counts.length > 0 ? ` · ${counts.join(" ")}` : ""}`;

  if (phase.focusTaskN === null || phase.focusTaskDesc === null) {
    return clampLine(prefix, contentBudget);
  }

  const focusPrefix = ` · #${phase.focusTaskN} `;
  const toolSuffix = phase.focusSubToolName
    ? ` · ${sanitizeTaskDetail(phase.focusSubToolName)}`
    : "";
  const fixedWidth = stringWidth(prefix) + stringWidth(focusPrefix);
  const minimumDescriptionWidth = 4;
  const suffix = fixedWidth + minimumDescriptionWidth + stringWidth(toolSuffix) <= contentBudget
    ? toolSuffix
    : "";
  const descriptionBudget = Math.max(
    1,
    contentBudget - fixedWidth - stringWidth(suffix),
  );
  const description = clampLine(
    sanitizeTaskDetail(phase.focusTaskDesc),
    descriptionBudget,
  );
  return clampLine(`${prefix}${focusPrefix}${description}${suffix}`, contentBudget);
}

function sanitizeTaskDetail(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * Done 状态行渲染——按 AgentRunEndReason 差异化 glyph + 文案，单一事实源接管
 * 所有 turn 终止反馈（completed / aborted / error / max_turns）。
 *
 *   completed  → ◆ 用时 1s         (◆ + 全行 dim 弱化色)
 *   aborted    → ⏵ 已中断 (esc) · 1s
 *   error      → ✗ 错误 (rate_limit) · 1s
 *   max_turns  → ⚠ 达到 turn 上限 · 1s
 *
 * **不显示 token**：过程中括号已实时累加显示一轮的 input / output token；任务结束
 * 后这些过程数据不再有意义，仅保留时长作为"耗时反馈"。
 *
 * completed 路径用 dim 颜色——表达"已完成、不再活跃"的静默感；与流转中 brand 亮色
 * spinner 形成"动→静且强→弱"的双轴过渡。◆ 字符在 spinner 帧 3 出现，形态守恒。
 */
function renderDonePhase(phase: Phase & { kind: "done" }): string {
  switch (phase.reason) {
    case "completed":
      return `${tone.dim(COMPLETED_GLYPH)} ${tone.dim(VERBS.done(phase.durationMs))}`;
    case "aborted": {
      const reasonText = formatAbortReasonShort(phase.abortReason);
      return `${tone.dim("⏵")} ${tone.dim(`已中断 (${reasonText}) · ${formatDuration(phase.durationMs)}`)}`;
    }
    case "error": {
      const errLabel = phase.errorType ?? "unknown";
      return `✗ ${tone.dim(`错误 (${errLabel}) · ${formatDuration(phase.durationMs)}`)}`;
    }
    case "max_turns":
      return `⚠ ${tone.dim(`达到 turn 上限 · ${formatDuration(phase.durationMs)}`)}`;
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
    committedInput: 0,
    committedOutput: 0,
    streamingOutput: 0,
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
    committedInput: phase.committedInput,
    committedOutput: phase.committedOutput,
    streamingOutput: phase.streamingOutput,
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

function deriveTaskCounts(
  tasks: Iterable<TaskState>,
): Pick<
  TaskAggregateState,
  "activeCount" | "completedCount" | "failedCount" | "abortedCount"
> {
  let activeCount = 0;
  let completedCount = 0;
  let failedCount = 0;
  let abortedCount = 0;
  for (const task of tasks) {
    if (task.status === "running") activeCount += 1;
    if (task.status === "succeeded") completedCount += 1;
    if (task.status === "failed") failedCount += 1;
    if (task.status === "aborted") abortedCount += 1;
  }
  return {
    activeCount,
    completedCount,
    failedCount,
    abortedCount,
  };
}

function phaseStartTime(
  phase: Exclude<Phase, { kind: "idle" } | { kind: "done" }>,
): number {
  return phase.startTime;
}

// ─── 数据估算 ───

/**
 * 从 stream event 估算本帧新增 token —— 复用 core 的 CJK 一等公民估算器
 * （estimateTextTokensRaw：CJK 1.5 / emoji 2.0 / Latin 0.25 逐 code point 加权），
 * 取代旧的 `字符数/2.5` 常数粗估。后者对中文约 4x 低估，流式 ↓ 边打边跳。
 *
 * 仍是过程估算：request_end 时 streamingOutput 清零、由 usage 真值覆盖，
 * 本函数只决定"流式进行中"那段的体感精度，不影响 turn 末真值。
 * StreamEvent 是 discriminated union，按 type 字段缩窄安全提取文本。
 */
function estimateStreamTokens(
  event: AgentEventMap["llm:stream_event"],
): number {
  if (event.type === "text_delta") return estimateTextTokensRaw(event.text);
  if (event.type === "thinking_delta")
    return estimateTextTokensRaw(event.thinking);
  if (event.type === "tool_call_delta")
    return estimateTextTokensRaw(event.argsFragment);
  return 0;
}

/** 从 Task 工具 input 提取 description（与 sub-agent-status 兼容） */
function extractTaskDescription(input: Record<string, unknown>): string {
  const raw = input["description"];
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return "(未命名)";
}
