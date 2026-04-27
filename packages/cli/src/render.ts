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
import {
  type AbortReason,
  type AgentEventMap,
  type AgentResult,
  type AgentYield,
  type ContextBudget,
  type IEventBus,
  getAgentIdentity,
} from "@zhixing/core";

// ─── Spinner 常量 ───

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
// 主文本 + esc 中断提示: 让用户在 agent 跑时看到中断键位 (替代独立状态条,
// 避免与 typeahead-input 在 idle 时的输入区冲突)
const SPINNER_TEXT = "思考中...";
const SPINNER_HINT = "esc 中断";
// 清除宽度足够覆盖 spinner 行 + 提示 (CJK 字符占 2 列, 需要比 .length 更大的值);
// "思考中... · esc 中断" 约 22 列, 留余量到 50
const SPINNER_CLEAR_WIDTH = 50;

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
        `\r  ${chalk.cyan(char)} ${chalk.dim(SPINNER_TEXT)} ${chalk.dim("·")} ${chalk.dim(SPINNER_HINT)}`,
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

// ─── 中断诊断文本 ───

/**
 * 把 AbortReason 渲染为一行用户可读的诊断文本。
 *
 * 用于:
 * - renderSummary 在 abort 路径显示差异化文本(reason 来自 AgentResult.abortReason)
 * - setupInterruptRendering 在 interrupt:fired 事件触发时显示中断原因
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

// ─── 运行结果摘要 ───

/**
 * 渐进式每轮摘要行。
 *
 * 终止类型差异化:
 *   - completed:    时间 + 上下文(渐进密度)
 *   - aborted:      "interrupted by ..."(reason 差异化文本) + 时间
 *   - max_turns:    "max turns reached (N)"(不读 abortReason —— 与 abort 体系平行)
 *   - error:        "error: <type> - <message>" + 时间
 *
 * 上下文信息密度随使用率递增(仅 completed 路径):
 *   < 50%  安静期: 只显示耗时
 *   50~75% 感知期: 耗时 + 上下文百分比(dim)
 *   75~85% 警示期: 耗时 + 黄色警告百分比
 *   > 85%  紧急期: 耗时 + 红色警告百分比
 */
export function renderSummary(
  result: AgentResult,
  durationMs: number,
  budget?: ContextBudget,
): void {
  const duration = (durationMs / 1000).toFixed(1);

  // abort 路径: reason 差异化文本(yellow), 不混入 budget 显示
  if (result.reason === "aborted") {
    const summary = formatAbortReasonSummary(result.abortReason);
    console.log(`\n${chalk.dim("─")} ${chalk.yellow(summary)} ${chalk.dim(`· ${duration}s`)}`);
    return;
  }

  // max_turns 路径: 显示上限值 (来自 result 自描述, 单一事实源)
  // 与 abort 体系平行 —— "达到上限" vs "被中断" 语义独立, 不读 abortReason
  if (result.reason === "max_turns") {
    console.log(
      `\n${chalk.dim("─")} ${chalk.yellow(`max turns reached (${result.maxTurns})`)} ${chalk.dim(`· ${duration}s`)}`,
    );
    return;
  }

  // error 路径: 错误类型 + 消息
  if (result.reason === "error") {
    const errType = result.error.type ?? "unknown";
    console.log(
      `\n${chalk.dim("─")} ${chalk.red(`error: ${errType}`)} ${chalk.dim(`· ${duration}s`)}`,
    );
    return;
  }

  // completed 路径: 渐进式信息密度
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

// ─── 中断 EventBus 渲染编排 ───

/**
 * 中断渲染装载句柄。run 结束时调 dispose 卸载 listener,避免跨 run 累积。
 */
export interface InterruptRenderingHandle {
  dispose(): void;
}

/**
 * 装载 EventBus 中断事件 → 终端可视反馈:
 *
 * - `interrupt:warn` → 启动每秒倒计时 ticker, 输出 "stream slow, will auto-cancel in Ns..."。
 *   倒计时来源:`Date.now() + (timeoutMs - elapsedMs)` 锚定 watchdog 的 abort 截止时间;
 *   用 console.warn 单行输出(每秒一行),非 \r 原地刷新——跨平台稳定 + 与 watchdog 自身日志
 *   风格一致, 用户能在终端 grep/scroll 历史警告记录。
 *
 * - `llm:stream_event` → 清理 ticker (chunk 到达 = stream 恢复活跃, watchdog 已 reset 内部
 *   timer, 屏幕侧也应隐藏倒计时避免误导)。
 *
 * - `interrupt:fired` → 清理 ticker + 输出 dim `[interrupted]` 标记 + reason summary。
 *   `[interrupted]` 走 stdout (接在 LLM 文本之后形成视觉连续);summary 走 console.warn
 *   (与 watchdog 警告同 stream 便于诊断)。
 *
 * - `agent:run_end` → 兜底清理 ticker (即使 fired 在 abort 路径外不发,run_end 一定发)。
 *
 * 返回 dispose 函数, 调用方在 run() 结束 finally 调一次, 确保 listener 不跨 run 累积。
 */
export function setupInterruptRendering(
  eventBus: IEventBus<AgentEventMap>,
  pauseUI: () => void,
): InterruptRenderingHandle {
  let warnTicker: ReturnType<typeof setInterval> | null = null;
  let warnDeadline: number | null = null;

  const clearWarnTicker = (): void => {
    if (warnTicker !== null) {
      clearInterval(warnTicker);
      warnTicker = null;
      warnDeadline = null;
    }
  };

  const onWarn = (e: AgentEventMap["interrupt:warn"]) => {
    clearWarnTicker();
    // deadline 锚定 watchdog 的 abort 触发时刻: e.timeoutMs - e.elapsedMs 是距离 abort
    // 还剩多久 (Date.now 在 fake timer 测试中也被 vitest mock, 行为可预测)
    warnDeadline = Date.now() + (e.timeoutMs - e.elapsedMs);
    const tick = () => {
      if (warnDeadline === null) return;
      const remaining = Math.max(0, Math.ceil((warnDeadline - Date.now()) / 1000));
      pauseUI();
      console.warn(
        chalk.yellow(`  ⚠ stream slow, will auto-cancel in ${remaining}s...`),
      );
      if (remaining <= 0) clearWarnTicker();
    };
    tick(); // 立即输出第一行, 不等 1s
    warnTicker = setInterval(tick, 1000);
  };

  const onStreamEvent = () => {
    // chunk 到达 = stream 恢复活跃: watchdog 内部已 reset timer, 屏幕也应隐藏倒计时
    clearWarnTicker();
  };

  const onFired = (e: AgentEventMap["interrupt:fired"]) => {
    clearWarnTicker();
    pauseUI();
    // dim [interrupted] 接在 LLM 文本之后, 形成视觉连续: 用户看到 LLM 输出戛然而止 + dim 标记
    // 标识 partial 状态。stdout 走 (与 LLM text_delta 同 stream), 不混入 stderr 警告
    process.stdout.write(chalk.dim("\n[interrupted]\n"));
    const summary = formatAbortReasonSummary(e.reason);
    console.warn(chalk.yellow(`  ⚠ ${summary}`));
  };

  const onRunEnd = () => {
    clearWarnTicker();
  };

  eventBus.on("interrupt:warn", onWarn);
  eventBus.on("llm:stream_event", onStreamEvent);
  eventBus.on("interrupt:fired", onFired);
  eventBus.on("agent:run_end", onRunEnd);

  return {
    dispose() {
      clearWarnTicker();
      eventBus.off("interrupt:warn", onWarn);
      eventBus.off("llm:stream_event", onStreamEvent);
      eventBus.off("interrupt:fired", onFired);
      eventBus.off("agent:run_end", onRunEnd);
    },
  };
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

/**
 * 渲染 compact 事务开始锚点（事务级，不含 strategy 名）。
 *
 * Phase 3 事务化后：每次 compact 事务仅 fire 一次 compact_start，payload
 * 不带单 strategy 名（事务里可能跑多个 strategy，名字在 compact_end 的 strategies 列出）。
 */
export function renderCompactStart(info: { tokensBefore: number }): void {
  const tokens = formatTokenCount(info.tokensBefore);
  process.stdout.write(
    `  ${chalk.yellow("⟳")} ${chalk.yellow("压缩中")} ${chalk.dim(`(${tokens} tokens)`)}\n`,
  );
}

/**
 * 渲染 compact 事务结束（事务级，汇总所有 strategy 贡献）。
 *
 * 显示策略：
 *   - 任一 strategy.success === true → "压缩完成 X → Y (节省 Z%) (name1 + name2)"
 *   - 全部 success === false         → "压缩无效（所有策略跳过或失败）"
 */
export function renderCompactEnd(info: {
  strategies: readonly { name: string; success: boolean }[];
  tokensBefore: number;
  tokensAfter: number;
}): void {
  const anySuccess = info.strategies.some((s) => s.success);
  if (anySuccess) {
    const before = formatTokenCount(info.tokensBefore);
    const after = formatTokenCount(info.tokensAfter);
    const savedPct =
      info.tokensBefore > 0
        ? Math.round(
            ((info.tokensBefore - info.tokensAfter) / info.tokensBefore) * 100,
          )
        : 0;
    // 列出实际产生效果的 strategy 名
    const activeNames = info.strategies
      .filter((s) => s.success)
      .map((s) => s.name)
      .join(" + ");
    process.stdout.write(
      `  ${chalk.green("✓")} ${chalk.dim(`压缩完成: ${before} → ${after} (节省 ${savedPct}%) (${activeNames})`)}\n`,
    );
  } else {
    // 所有策略都 skip 或失败（例如 abort / 熔断）
    const attemptedNames = info.strategies.map((s) => s.name).join(", ");
    process.stdout.write(
      `  ${chalk.red("✗")} ${chalk.dim(`压缩无效（尝试: ${attemptedNames}）`)}\n`,
    );
  }
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ─── /usage 命令渲染 ───

export function renderUsageReport(budget: ContextBudget, turnCount: number, calibrationFactor?: number): void {
  const pct = Math.round(budget.usageRatio * 100);
  const current = formatTokenCount(budget.currentTokens);
  const effective = formatTokenCount(budget.effectiveWindow);

  console.log(`\n  ${chalk.bold("Token 用量")}`);
  console.log(chalk.dim("  ─────────────────────────────"));
  console.log(`  ${chalk.dim("上下文容量")}     ${formatStatusColor(pct, budget.status)}  ${chalk.dim(`(${current} / ${effective})`)}`);
  console.log(`  ${chalk.dim("上下文窗口")}     ${formatTokenCount(budget.contextWindow)}`);
  console.log(`  ${chalk.dim("会话轮次")}       ${turnCount} 轮`);
  if (calibrationFactor !== undefined) {
    const calStr = calibrationFactor.toFixed(3);
    const label = calibrationFactor === 1.0 ? "未校准" : "已校准";
    console.log(`  ${chalk.dim("估算校准")}       ${calStr} ${chalk.dim(`(${label})`)}`);
  }
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
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
    const configPath = `${home}/.zhixing/config.json`;
    console.error(
      `\n${chalk.red("✗")} ${chalk.red.bold("配置错误")}: ${error.message}`,
    );
    console.error(chalk.dim(`\n  请检查配置文件: ${configPath}\n`));
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
 *   2. 显示名逐字打出（每字 70ms）
 *   3. 模型名淡入
 *   4. 短暂停顿后进入 prompt
 *
 * 非 TTY 环境（管道/CI）降级为静态单行输出。
 *
 * 显示名来自 getAgentIdentity()，默认 "知行"，可被 config 覆盖。
 */
export async function renderWelcome(options: {
  model: string;
  workspace?: { path: string | null; source: string };
  workspaceDirStatus?: string;
}): Promise<void> {
  const { model, workspace, workspaceDirStatus } = options;
  const { displayName } = getAgentIdentity();

  if (!process.stdout.isTTY) {
    const wsInfo = workspace?.path ? ` · ${workspace.path}` : "";
    console.log(`${displayName} · ${model}${wsInfo}`);
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
  for (const char of displayName) {
    process.stdout.write(chalk.bold(char));
    await sleep(70);
  }
  console.log();

  // Phase 3: 模型名静默出现
  await sleep(60);
  console.log(`    ${chalk.dim(model)}`);

  // Phase 4: 工作区信息（按场景区分）
  if (workspace?.path) {
    renderWorkspaceStatus(workspace.path, workspace.source, workspaceDirStatus);
  }
  console.log();
}

/**
 * 按启动场景渲染工作区状态：
 * - created：首次启动，工作区刚创建
 * - exists：正常启动，一行简要
 * - skipped（有路径）：目录创建失败，警告
 * - cwd-fallback：无配置，使用当前目录
 */
function renderWorkspaceStatus(
  wsPath: string,
  source: string,
  dirStatus?: string,
): void {
  if (dirStatus === "created") {
    // 首次创建
    console.log(`    ${chalk.green(`workspace: ${wsPath}`)}`);
    console.log(`    ${chalk.dim("工作区已创建。常规文件读写在此目录内无需逐次确认。")}`);
    console.log(`    ${chalk.dim('如需修改，告诉我「把工作区改到 xxx」即可。')}`);
    return;
  }

  if (dirStatus === "skipped" && source !== "cwd-fallback" && source !== "none") {
    // 配置了路径但创建失败
    console.log(`    ${chalk.yellow(`⚠ workspace: ${wsPath}`)}`);
    console.log(`    ${chalk.yellow("工作区目录不存在且无法创建，请检查路径或权限。")}`);
    return;
  }

  // 正常启动 / cwd-fallback
  const sourceLabel = formatWorkspaceSource(source);
  console.log(`    ${chalk.dim(`workspace: ${wsPath}`)}${sourceLabel}`);
}

/** 将工作区来源转为简短的中文标注 */
function formatWorkspaceSource(source: string): string {
  switch (source) {
    case "cli":
      return chalk.dim(" (--workspace)");
    case "directory-config":
      return chalk.dim(" (目录配置)");
    case "global-config":
      return "";  // 全局配置是默认来源，不额外标注
    case "cwd-fallback":
      return chalk.dim(" (当前目录)");
    default:
      return "";
  }
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
