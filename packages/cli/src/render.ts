/**
 * 终端渲染模块
 *
 * 职责：将 AgentYield 事件转为终端可视输出。
 * MVP 方案：chalk 直接着色 + process.stdout.write 流式输出。
 * 不引入 Ink/React/ora 等终端 UI 框架。
 *
 * Spinner 实现：自研 Braille dots 动画，零依赖。
 * 时序规则：
 *   start  → 用户回车后立即启动
 *   stop   → 收到首个 text_delta / thinking_delta / tool_start 时自动停止
 *   resume → turn_complete 后自动恢复（等待下一轮 LLM 响应）
 */

import chalk from "chalk";
import type { AgentResult, AgentYield, ContextBudget } from "@zhixing/core";

// ─── Spinner 常量 ───

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const SPINNER_TEXT = "思考中...";
// 清除宽度足够覆盖 spinner 行（CJK 字符占 2 列，需要比 .length 更大的值）
const SPINNER_CLEAR_WIDTH = 30;

// ─── 有状态渲染器 ───

export interface Renderer {
  /** 启动思考动画（用户输入后立即调用） */
  startThinking: () => void;
  /** 处理 AgentYield 事件（自动管理 spinner 生命周期） */
  handleEvent: (event: AgentYield) => void;
  /** 强制停止 spinner（异常路径兜底） */
  stop: () => void;
}

export function createRenderer(): Renderer {
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  // 追踪光标是否在行首，避免 tool_start 产生多余空行
  let atLineStart = true;
  // 追踪本轮是否已输出可见内容，过滤 LLM 在工具调用前输出的前导空白
  let hasVisibleContent = false;

  function startSpinner(): void {
    stopSpinner();
    frame = 0;
    timer = setInterval(() => {
      const char = SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length]!;
      process.stdout.write(
        `\r  ${chalk.cyan(char)} ${chalk.dim(SPINNER_TEXT)}`,
      );
    }, SPINNER_INTERVAL_MS);
  }

  function stopSpinner(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
      process.stdout.write(`\r${" ".repeat(SPINNER_CLEAR_WIDTH)}\r`);
    }
  }

  function renderEvent(event: AgentYield): void {
    switch (event.type) {
      case "text_delta":
        // 过滤每轮开头的纯空白（LLM 在工具调用前常输出多余换行）
        if (!hasVisibleContent) {
          if (event.text.trim() === "") break;
          hasVisibleContent = true;
        }
        process.stdout.write(event.text);
        atLineStart = event.text.endsWith("\n");
        break;

      case "thinking_delta":
        hasVisibleContent = true;
        process.stdout.write(chalk.dim(event.thinking));
        atLineStart = event.thinking.endsWith("\n");
        break;

      case "assistant_message":
        break;

      case "tool_start":
        if (!atLineStart) process.stdout.write("\n");
        process.stdout.write(
          `  ${chalk.cyan("⟡")} ${chalk.cyan(event.name)} ${chalk.dim(getToolSummary(event.name, event.input))} `,
        );
        atLineStart = false;
        break;

      case "tool_end": {
        const status = event.result.isError
          ? chalk.red("✗")
          : chalk.green("✓");
        process.stdout.write(`${status} ${chalk.dim(`${event.duration}ms`)}\n`);
        atLineStart = true;
        break;
      }

      case "turn_complete":
        break;
    }
  }

  return {
    startThinking() {
      atLineStart = true;
      hasVisibleContent = false;
      startSpinner();
    },

    handleEvent(event: AgentYield) {
      if (
        timer !== null &&
        (event.type === "text_delta" ||
          event.type === "thinking_delta" ||
          event.type === "tool_start")
      ) {
        stopSpinner();
      }

      if (event.type === "turn_complete") {
        hasVisibleContent = false;
        startSpinner();
      }

      renderEvent(event);
    },

    stop() {
      stopSpinner();
    },
  };
}

// ─── 运行结果摘要 ───

/**
 * 渐进式每轮摘要行。
 *
 * 信息密度随上下文使用率递增：
 *   < 50%  安静期：只显示耗时
 *   50~75% 感知期：耗时 + 上下文百分比（dim）
 *   75~85% 警示期：耗时 + 黄色警告百分比
 *   > 85%  紧急期：耗时 + 红色警告百分比
 */
export function renderSummary(
  _result: AgentResult,
  durationMs: number,
  budget?: ContextBudget,
): void {
  const duration = (durationMs / 1000).toFixed(1);
  const parts: string[] = [chalk.dim(`${duration}s`)];

  if (budget) {
    const pct = Math.round(budget.usageRatio * 100);
    const contextLabel = `上下文 ${pct}%`;

    switch (budget.status) {
      case "critical":
        parts.push(chalk.red(`🔴 ${contextLabel}`));
        break;
      case "compact":
        parts.push(chalk.yellow(`⚠ ${contextLabel}`));
        break;
      case "warning":
        parts.push(chalk.yellow(`⚠ ${contextLabel}`));
        break;
      case "normal":
        if (budget.usageRatio >= 0.5) {
          parts.push(chalk.dim(contextLabel));
        }
        break;
    }
  }

  console.log(`\n${chalk.dim("─")} ${parts.join(chalk.dim(" · "))}`);
}

// ─── 重试事件渲染 ───

/** 渲染重试尝试提示（黄色警告） */
export function renderRetryAttempt(info: {
  errorType: string;
  attempt: number;
  maxRetries: number;
  delayMs: number;
}): void {
  const delayStr = (info.delayMs / 1000).toFixed(1);
  process.stdout.write(
    `\n  ${chalk.yellow("⚠")} ${chalk.yellow(formatErrorType(info.errorType))}` +
    `${chalk.dim(`, 第 ${info.attempt}/${info.maxRetries} 次重试，等待 ${delayStr}s...`)}`,
  );
}

/** 渲染重试成功提示（绿色） */
export function renderRetrySuccess(info: { attemptsTaken: number }): void {
  process.stdout.write(
    `\n  ${chalk.green("✓")} ${chalk.dim(`重试成功（第 ${info.attemptsTaken} 次）`)}\n`,
  );
}

/** 渲染重试耗尽提示（红色） */
export function renderRetryExhausted(info: {
  totalAttempts: number;
  lastError: string;
}): void {
  process.stdout.write(
    `\n  ${chalk.red("✗")} ${chalk.red(`重试耗尽（共 ${info.totalAttempts} 次）`)}: ${chalk.dim(info.lastError)}\n`,
  );
}

function formatErrorType(errorType: string): string {
  const labels: Record<string, string> = {
    rate_limit: "速率限制 (429)",
    timeout: "请求超时",
    network: "网络错误",
    provider_error: "服务端错误",
    unknown: "未知错误",
  };
  return labels[errorType] ?? errorType;
}

// ─── 上下文预算渲染 ───

/** 渲染上下文预算状态（每轮结束后显示） */
export function renderBudgetStatus(info: {
  currentTokens: number;
  effectiveWindow: number;
  usageRatio: number;
  status: string;
}): void {
  const pct = Math.round(info.usageRatio * 100);
  const current = formatTokenCount(info.currentTokens);
  const total = formatTokenCount(info.effectiveWindow);
  const label = `${pct}% · ${current}/${total} tokens`;

  let colorFn: (s: string) => string;
  switch (info.status) {
    case "critical":
      colorFn = chalk.red;
      break;
    case "compact":
      colorFn = chalk.yellow;
      break;
    case "warning":
      colorFn = chalk.yellow;
      break;
    default:
      colorFn = chalk.dim;
  }

  process.stdout.write(`  ${colorFn(`[${label}]`)}\n`);
}

/** 渲染压缩开始 */
export function renderCompactStart(info: {
  strategy: string;
  tokensBefore: number;
}): void {
  const tokens = formatTokenCount(info.tokensBefore);
  process.stdout.write(
    `  ${chalk.yellow("⟳")} ${chalk.yellow("压缩中")} ${chalk.dim(`(${info.strategy}, ${tokens} tokens)`)}\n`,
  );
}

/** 渲染压缩完成 */
export function renderCompactEnd(info: {
  strategy: string;
  tokensBefore: number;
  tokensAfter: number;
  success: boolean;
}): void {
  if (info.success) {
    const before = formatTokenCount(info.tokensBefore);
    const after = formatTokenCount(info.tokensAfter);
    const savedPct = info.tokensBefore > 0
      ? Math.round(((info.tokensBefore - info.tokensAfter) / info.tokensBefore) * 100)
      : 0;
    process.stdout.write(
      `  ${chalk.green("✓")} ${chalk.dim(`压缩完成: ${before} → ${after} (节省 ${savedPct}%)`)}\n`,
    );
  } else {
    process.stdout.write(
      `  ${chalk.red("✗")} ${chalk.dim(`压缩失败 (${info.strategy})`)}\n`,
    );
  }
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ─── /usage 命令渲染 ───

export function renderUsageReport(budget: ContextBudget, turnCount: number): void {
  const pct = Math.round(budget.usageRatio * 100);
  const current = formatTokenCount(budget.currentTokens);
  const effective = formatTokenCount(budget.effectiveWindow);

  console.log(`\n  ${chalk.bold("Token 用量")}`);
  console.log(chalk.dim("  ─────────────────────────────"));
  console.log(`  ${chalk.dim("上下文容量")}     ${formatStatusColor(pct, budget.status)}  ${chalk.dim(`(${current} / ${effective})`)}`);
  console.log(`  ${chalk.dim("上下文窗口")}     ${formatTokenCount(budget.contextWindow)}`);
  console.log(`  ${chalk.dim("会话轮次")}       ${turnCount} 轮`);
  console.log();
}

// ─── /context 命令渲染 ───

export function renderContextVisual(budget: ContextBudget): void {
  const pct = Math.round(budget.usageRatio * 100);
  const effective = formatTokenCount(budget.effectiveWindow);
  const barWidth = 40;
  const filled = Math.min(barWidth, Math.round((budget.usageRatio) * barWidth));
  const empty = barWidth - filled;

  const filledChar = budget.status === "critical" ? chalk.red("█")
    : budget.status === "compact" || budget.status === "warning" ? chalk.yellow("█")
    : chalk.green("█");
  const bar = filledChar.repeat(filled) + chalk.dim("░").repeat(empty);

  console.log(`\n  ${chalk.bold("上下文窗口")} ${chalk.dim(`(${effective} tokens)`)}`);
  console.log(chalk.dim("  ──────────────────────────────────────────────"));
  console.log(`  [${bar}] ${formatStatusColor(pct, budget.status)}`);

  // 阈值标尺
  console.log();
  console.log(`  ${chalk.dim("阈值:")}`);
  console.log(`    ${chalk.dim("──")} 预警 (75%) ${chalk.dim("─────────")} ${formatTokenCount(Math.round(budget.effectiveWindow * 0.75))}`);
  console.log(`    ${chalk.dim("──")} 压缩 (85%) ${chalk.dim("─────────")} ${formatTokenCount(Math.round(budget.effectiveWindow * 0.85))}`);
  console.log(`    ${chalk.dim("──")} 上限 (95%) ${chalk.dim("─────────")} ${formatTokenCount(Math.round(budget.effectiveWindow * 0.95))}`);

  if (budget.status === "warning" || budget.status === "compact" || budget.status === "critical") {
    console.log();
    console.log(`  ${chalk.yellow("提示:")} 使用 ${chalk.cyan("/compact")} 手动触发压缩`);
  }
  console.log();
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

export function renderError(error: unknown): void {
  if (error instanceof Error && error.name === "ProviderConfigError") {
    console.error(
      `\n${chalk.red("✗")} ${chalk.red.bold("配置错误")}: ${error.message}`,
    );
    console.error(chalk.dim("\n  运行 zhixing config 查看当前配置\n"));
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n${chalk.red("✗")} ${message}`);
}

// ─── 欢迎动画 ───

/**
 * 欢迎页面：打字动画 + 极简信息。
 *
 * 视觉序列（TTY 模式，~400ms）：
 *   1. "✦" 出现（80ms 预等待）
 *   2. "知行" 逐字打出（每字 70ms）
 *   3. 模型名淡入
 *   4. 短暂停顿后进入 prompt
 *
 * 非 TTY 环境（管道/CI）降级为静态单行输出。
 */
export async function renderWelcome(options: { model: string }): Promise<void> {
  const { model } = options;

  if (!process.stdout.isTTY) {
    console.log(`知行 · ${model}`);
    return;
  }

  console.log();

  // Phase 1: 标志出现
  process.stdout.write("  ");
  await sleep(80);
  process.stdout.write(chalk.cyan.bold("✦"));
  await sleep(120);

  // Phase 2: 名称逐字打出
  process.stdout.write(" ");
  for (const char of "知行") {
    process.stdout.write(chalk.bold(char));
    await sleep(70);
  }
  console.log();

  // Phase 3: 模型名静默出现
  await sleep(60);
  console.log(`    ${chalk.dim(model)}`);
  console.log();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── 内部辅助 ───

function getToolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "read":
    case "write":
      return typeof input["path"] === "string" ? input["path"] : "";
    case "bash": {
      const cmd =
        typeof input["command"] === "string" ? input["command"] : "";
      return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
    }
    default:
      return "";
  }
}
