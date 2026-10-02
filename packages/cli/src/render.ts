/** Terminal-only rendering and composition of shared run notices. */
import chalk from "chalk";
import type { AbortReason } from "@zhixing/core/interrupt";
import type { ContextBudget } from "@zhixing/core/context";
import type { DecorateRunBusFn } from "@zhixing/orchestrator/runtime";
import type { RuntimeSubAgentUsageEntry } from "@zhixing/owner-kernel/types";
import type { OutputRenderer } from "./output/output-renderer.js";
import type { CliWriter, ScreenController } from "./screen/index.js";
import { createStatusBar, type StatusBarHandle } from "./status-bar/index.js";
import { createContextIndicator, type ContextIndicatorHandle } from "./context-indicator/index.js";
import type { LifecycleWarningDeduper } from "./lifecycle-diagnostics-presentation.js";
import { renderSubtaskUsageLines } from "./subtasks/presentation.js";
import { getTerminalWidth } from "./tui/style.js";
import { createRunEventSubscribers, formatTokenCount } from "./render-events.js";
export { setupInterruptRendering, renderRetryAttempt, renderRetrySuccess, renderRetryExhausted,
  renderSegmentStart, renderSegmentEnd, renderSegmentFailed, renderEmergencyFloor,
  type InterruptRenderingHandle } from "./render-events.js";

// ─── 中断诊断文本 ───

/**
 * 把 AbortReason 渲染为一行用户可读的诊断文本——完整版（用于日志 / 终端摘要）。
 *
 * status-bar 用 verbs.formatAbortReasonShort 取简短标签（空间有限）；本函数返回
 * 完整诊断文本（如 "interrupted by user (esc)"），供 server 日志 / serve 通知 / 测试断言。
 *
 * `null` / `undefined` 路径对应"外部 signal 直接 abort 但无类型化 reason"
 * (裸 AbortController.abort() / 非本模块识别的 reason),返回兜底文本"interrupted"
 * 让用户知道发生了中断,不暴露内部 null。
 */
export function formatAbortReasonSummary(
  reason: AbortReason | null | undefined,
): string {
  if (!reason) return "interrupted";
  switch (reason.kind) {
    case "user-cancel": {
      // ctrl-c 是 source 字段值, 显示用 "ctrl+c" 符合用户终端键位惯例
      const label = reason.source === "ctrl-c" ? "ctrl+c" : reason.source;
      return `interrupted by user (${label})`;
    }
    case "idle-timeout": {
      const seconds = Math.floor(reason.timeoutMs / 1000);
      return `interrupted: stream idle for ${seconds}s (${reason.chunksReceived} chunks received)`;
    }
    case "parent-abort": {
      // 子 agent 收到父 abort: 透传父 reason kind 让用户追溯到根因 (esc / scheduler / ...)
      const parent = reason.parentReason?.kind ?? "unknown";
      return `interrupted by parent (${parent})`;
    }
    case "external": {
      // origin 由调用方在创建 ext signal 时标注 (如 "scheduler-task-timeout"),
      // 缺省时仅显示通用 "external signal"
      return `interrupted by external signal${reason.origin ? ` (${reason.origin})` : ""}`;
    }
  }
}

// ─── /usage 命令渲染 ───

/**
 * /usage 命令的可视化输出 —— 主 agent 用量 + 可选的子 agent Task 拆分。
 *
 * 子 usage 的设计原则:
 *   - 向后兼容:不传 subUsages / 空数组时输出与既有完全一致(布局/换行)
 *   - 视觉分隔:用与主段一致的虚线分隔,避免紧贴产生信息密度过高
 *   - 状态可视化:✓ 成功(绿)/ ⚠ 失败(黄)/ ⏵ 中止(灰),与全局状态色一致
 *   - 求和兜底:子 token 之和在末尾呈现,让用户一眼看出"调研型子任务总成本"
 */
export function renderUsageReport(
  budget: ContextBudget,
  turnCount: number,
  calibrationFactor: number | undefined,
  subUsages: readonly RuntimeSubAgentUsageEntry[] | undefined,
  writer: CliWriter,
): void {
  const pct = Math.round(budget.usageRatio * 100);
  const current = formatTokenCount(budget.currentTokens);
  const effective = formatTokenCount(budget.effectiveWindow);

  writer.line(`\n  ${chalk.bold("Token 用量")}`);
  writer.line(chalk.dim("  ─────────────────────────────"));
  writer.line(
    `  ${chalk.dim("上下文容量")}     ${formatStatusColor(pct, budget.status)}  ${chalk.dim(`(${current} / ${effective})`)}`,
  );
  writer.line(
    `  ${chalk.dim("上下文窗口")}     ${formatTokenCount(budget.contextWindow)}`,
  );
  writer.line(`  ${chalk.dim("会话轮次")}       ${turnCount} 轮`);
  if (calibrationFactor !== undefined) {
    const calStr = calibrationFactor.toFixed(3);
    const label = calibrationFactor === 1.0 ? "未校准" : "已校准";
    writer.line(
      `  ${chalk.dim("估算校准")}       ${calStr} ${chalk.dim(`(${label})`)}`,
    );
  }

  if (subUsages && subUsages.length > 0) {
    for (const line of renderSubtaskUsageLines(subUsages, {
      columns: getTerminalWidth(),
    })) {
      writer.line(line);
    }
    writer.line("");
  } else {
    writer.line("");
  }
}

// ─── /context 命令渲染 ───

export function renderContextVisual(
  budget: ContextBudget,
  writer: CliWriter,
): void {
  const pct = Math.round(budget.usageRatio * 100);
  const effective = formatTokenCount(budget.effectiveWindow);
  const barWidth = 40;
  const filled = Math.min(barWidth, Math.round(budget.usageRatio * barWidth));
  const empty = barWidth - filled;

  const filledChar =
    budget.status === "critical"
      ? chalk.red("█")
      : budget.status === "compact" || budget.status === "warning"
        ? chalk.yellow("█")
        : chalk.green("█");
  const bar = filledChar.repeat(filled) + chalk.dim("░").repeat(empty);

  writer.line(
    `\n  ${chalk.bold("上下文窗口")} ${chalk.dim(`(${effective} tokens)`)}`,
  );
  writer.line(chalk.dim("  ──────────────────────────────────────────────"));
  writer.line(`  [${bar}] ${formatStatusColor(pct, budget.status)}`);

  // 阈值标尺
  writer.line("");
  writer.line(`  ${chalk.dim("阈值:")}`);
  writer.line(
    `    ${chalk.dim("──")} 预警 (75%) ${chalk.dim("─────────")} ${formatTokenCount(Math.round(budget.effectiveWindow * 0.75))}`,
  );
  writer.line(
    `    ${chalk.dim("──")} 压缩 (85%) ${chalk.dim("─────────")} ${formatTokenCount(Math.round(budget.effectiveWindow * 0.85))}`,
  );
  writer.line(
    `    ${chalk.dim("──")} 上限 (95%) ${chalk.dim("─────────")} ${formatTokenCount(Math.round(budget.effectiveWindow * 0.95))}`,
  );

  if (
    budget.status === "warning" ||
    budget.status === "compact" ||
    budget.status === "critical"
  ) {
    writer.line("");
    writer.line(
      `  ${chalk.yellow("提示:")} 使用 ${chalk.cyan("/compact")} 手动触发压缩`,
    );
  }
  writer.line("");
}

function formatStatusColor(pct: number, status: string): string {
  const label = `${pct}%`;
  switch (status) {
    case "critical": return chalk.red.bold(label);
    case "compact": return chalk.yellow.bold(label);
    case "warning": return chalk.yellow(label);
    default: return chalk.green(label);
  }
}

// ─── 错误渲染 ───

export function renderError(error: unknown, writer: CliWriter): void {
  if (error instanceof Error && error.name === "ProviderConfigError") {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
    const configPath = `${home}/.zhixing/config.json`;
    writer.line(
      `\n${chalk.red("✗")} ${chalk.red.bold("配置错误")}: ${error.message}`,
    );
    writer.line(chalk.dim(`\n  请检查配置文件: ${configPath}`));
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  writer.line(`\n${chalk.red("✗")} ${message}`);
}

// ─── 集中渲染订阅装载点 ───

export interface CreateRenderSubscribersOptions {
  /** 可选 renderer——存在时 pauseUI 包装 renderer.stop()；否则退化为 no-op */
  readonly renderer?: OutputRenderer;
  /** CliWriter——所有事件渲染必须经此写屏，禁止直接 console.log */
  readonly writer: CliWriter;
  /** 可选 screen——存在时启用 status-bar 与 context-indicator；不经 writer */
  readonly screen?: ScreenController;
  /** lifecycle warning 展示去重器；同一终端接入面应与 control 事件展示共享。 */
  readonly lifecycleWarningDeduper?: LifecycleWarningDeduper;
}

/** Headless notices and terminal chrome share one run-scoped disposer. */
export function createRenderSubscribers(options: CreateRenderSubscribersOptions): DecorateRunBusFn {
  const decorate = createRunEventSubscribers(options);
  return (ctx) => {
    const disposeNotices = decorate(ctx);
    let statusBar: StatusBarHandle | undefined;
    let contextIndicator: ContextIndicatorHandle | undefined;
    const dispose = () => {
      disposeNotices();
      statusBar?.dispose();
      contextIndicator?.dispose();
    };
    try {
      if (options.screen) {
        statusBar = createStatusBar({ screen: options.screen, eventBus: ctx.bus });
        contextIndicator = createContextIndicator({ screen: options.screen, eventBus: ctx.bus });
      }
      return dispose;
    } catch (error) {
      dispose();
      throw error;
    }
  };
}
