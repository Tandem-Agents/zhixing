/**
 * 终端渲染模块——AI 输出区主流程之外的辅助渲染。
 *
 * 主流程的 AgentYield 流（text / thinking / tool / turn_complete）由 output/ 子模块
 * 的 createOutputRenderer 接管；本文件保留剩余的"非流式"渲染：
 *   - renderSummary：每轮结束摘要行（耗时 / 上下文 / 中断 / 错误 / max_turns 差异化）
 *   - renderError：异常错误渲染
 *   - renderUsageReport / renderContextVisual：/usage 与 /context 命令的可视化
 *   - renderRetry* / renderBudgetStatus / renderCompact*：EventBus 订阅型事件渲染
 *   - setupInterruptRendering：中断 EventBus 订阅渲染
 *   - createRenderSubscribers：装载 EventBus 渲染订阅的工厂
 *
 * 这些函数与 createOutputRenderer 互不耦合，由 repl / run-agent 各自调用。
 */

import chalk from "chalk";
import {
  type AbortReason,
  type AgentEventMap,
  type AgentResult,
  type ContextBudget,
  type IEventBus,
} from "@zhixing/core";
import type { DecorateRunBusFn } from "@zhixing/orchestrator/runtime";
import type { SubAgentUsageEntry } from "./parse-task-usage.js";
import { setupSubAgentStatus } from "./sub-agent-status.js";
import type { OutputRenderer } from "./output/index.js";

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

/** stderr 倒计时行清空宽度 (覆盖最长 "  ⚠ stream slow, will auto-cancel in 30s..." 含 chalk 控制字符余量) */
const WARN_LINE_CLEAR_WIDTH = 60;

/**
 * 装载 EventBus 中断事件 → 终端可视反馈:
 *
 * - `interrupt:warn` → 启动每秒倒计时, 输出 "stream slow, will auto-cancel in Ns..."。
 *   - **TTY 模式**: \r 原地刷新单行 (避免每秒多输出一行刷屏)
 *   - **非 TTY 模式**: 仅输出一次警告, 不 ticker (CI / 日志重定向场景日志不爆炸)
 *   - 首次 tick 前先打 \n: 隔开 watchdog 自身的 stderr 日志或 spinner 残留, 避免同行混杂
 *
 * - `llm:stream_event` → 清理 ticker + 擦倒计时残留 (chunk 到达 = stream 恢复活跃)。
 *
 * - `interrupt:fired` → 清理 ticker + 擦倒计时残留 + 输出 dim `[interrupted]` 视觉标记。
 *   走 stdout 接在 LLM 文本之后形成视觉连续。reason 文本由 renderSummary 在
 *   终止摘要行展示, 此处不重复输出避免冗余 (终端 UX 关注点分离: fired 标记
 *   abort 瞬间, summary 展示终止原因)。
 *
 * - `agent:run_end` → 兜底清理 ticker (即使 fired 在 abort 路径外不发, run_end 一定发)。
 *
 * 返回 dispose 函数, 调用方在 run() 结束 finally 调一次, 确保 listener 不跨 run 累积。
 */
export function setupInterruptRendering(
  eventBus: IEventBus<AgentEventMap>,
  pauseUI: () => void,
): InterruptRenderingHandle {
  let warnTicker: ReturnType<typeof setInterval> | null = null;
  let warnDeadline: number | null = null;
  let warnLinePrinted = false; // 是否已用 \r 在 stderr 写入倒计时行 (TTY 模式), 决定是否需要清行

  const clearWarnLine = (): void => {
    // 仅 TTY 模式下需要清: 非 TTY 走的是 console.warn 一次性输出, 没有 \r 残留行
    if (warnLinePrinted && process.stderr.isTTY) {
      process.stderr.write(`\r${" ".repeat(WARN_LINE_CLEAR_WIDTH)}\r`);
    }
    warnLinePrinted = false;
  };

  const clearWarnTicker = (): void => {
    if (warnTicker !== null) {
      clearInterval(warnTicker);
      warnTicker = null;
      warnDeadline = null;
    }
  };

  const onWarn = (e: AgentEventMap["interrupt:warn"]) => {
    clearWarnTicker();
    clearWarnLine();
    // deadline 锚定 watchdog 的 abort 触发时刻: e.timeoutMs - e.elapsedMs 是距离 abort
    // 还剩多久 (Date.now 在 fake timer 测试中也被 vitest mock, 行为可预测)
    warnDeadline = Date.now() + (e.timeoutMs - e.elapsedMs);

    // 非 TTY (CI / pipe / 重定向): 只输出一次警告, 不 ticker 避免日志爆炸
    if (!process.stderr.isTTY) {
      pauseUI();
      const remaining = Math.max(0, Math.ceil((warnDeadline - Date.now()) / 1000));
      console.warn(
        chalk.yellow(`  ⚠ stream slow, will auto-cancel in ${remaining}s if no response`),
      );
      return;
    }

    // TTY: \r 原地刷新单行倒计时 (单行更新避免刷屏)
    let firstTick = true;
    const tick = () => {
      if (warnDeadline === null) return;
      const remaining = Math.max(0, Math.ceil((warnDeadline - Date.now()) / 1000));
      pauseUI();
      if (firstTick) {
        // 第一次 tick 前换行: 隔开 watchdog 自身的 stderr 日志(`[watchdog] stream idle...`)
        // 或残留 spinner, 避免倒计时附在前一行末尾形成视觉混杂
        process.stderr.write("\n");
        firstTick = false;
      }
      process.stderr.write(
        `\r${chalk.yellow(`  ⚠ stream slow, will auto-cancel in ${remaining}s...`)}`,
      );
      warnLinePrinted = true;
      if (remaining <= 0) {
        clearWarnLine();
        clearWarnTicker();
      }
    };
    tick(); // 立即输出第一行, 不等 1s
    warnTicker = setInterval(tick, 1000);
  };

  const onStreamEvent = () => {
    // chunk 到达 = stream 恢复活跃: watchdog 内部已 reset timer, 屏幕也应隐藏倒计时
    clearWarnTicker();
    clearWarnLine();
  };

  const onFired = (_e: AgentEventMap["interrupt:fired"]) => {
    clearWarnTicker();
    clearWarnLine();
    pauseUI();
    // dim [interrupted] 接在 LLM 文本之后, 形成视觉连续: 用户看到 LLM 输出戛然而止 + dim 标记
    // 标识 partial 状态。stdout 走 (与 LLM text_delta 同 stream), 与 stderr 警告分离。
    // reason 文本由 renderSummary 摘要行展示, 此处不重复输出避免冗余。
    process.stdout.write(chalk.dim("\n[interrupted]\n"));
  };

  const onRunEnd = () => {
    clearWarnTicker();
    clearWarnLine();
  };

  eventBus.on("interrupt:warn", onWarn);
  eventBus.on("llm:stream_event", onStreamEvent);
  eventBus.on("interrupt:fired", onFired);
  eventBus.on("agent:run_end", onRunEnd);

  return {
    dispose() {
      clearWarnTicker();
      clearWarnLine();
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
  calibrationFactor?: number,
  subUsages?: readonly SubAgentUsageEntry[],
): void {
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

  if (subUsages && subUsages.length > 0) {
    renderSubAgentUsageSection(subUsages);
  } else {
    console.log();
  }
}

/**
 * 把 SubAgentUsageEntry 数组渲染成 /usage 的"子 agent 拆分"段。
 *
 * 排版决策:
 *   - description 截断到 28 字符避免单行过长(中文 / emoji 计算用字符数,v1 简化)
 *   - 状态字段(toolUses / durationMs)仅 succeeded 显示;failed / aborted 显示 status 文字
 *   - durationMs → 秒(2 位小数),用户感知尺度优于毫秒原值
 */
function renderSubAgentUsageSection(entries: readonly SubAgentUsageEntry[]): void {
  console.log(chalk.dim("  ─────────────────────────────"));
  console.log(
    `  ${chalk.bold("子 agent 拆分")} ${chalk.dim(`(${entries.length} 个 Task)`)}`,
  );

  for (const entry of entries) {
    const desc = truncateForDisplay(entry.description, 28);
    const tokensFmt = formatTokenCount(entry.tokens);
    const icon =
      entry.status === "succeeded"
        ? chalk.green("✓")
        : entry.status === "failed"
          ? chalk.yellow("⚠")
          : chalk.dim("⏵");

    let extra = "";
    if (entry.status === "succeeded") {
      const parts: string[] = [];
      if (entry.toolUses !== undefined) {
        parts.push(`${entry.toolUses} tool_use${entry.toolUses === 1 ? "" : "s"}`);
      }
      if (entry.durationMs !== undefined) {
        parts.push(`${(entry.durationMs / 1000).toFixed(2)}s`);
      }
      extra = parts.length > 0 ? chalk.dim(`  (${parts.join(", ")})`) : "";
    } else {
      extra = chalk.dim(`  (${entry.status})`);
    }

    console.log(
      `  ${chalk.cyan("+")} Task#${entry.index} ${chalk.dim(`(${desc})`)}  ${icon} ${tokensFmt}${extra}`,
    );
  }

  const sum = entries.reduce((acc, e) => acc + e.tokens, 0);
  console.log(chalk.dim("  ─────────────────────────────"));
  console.log(
    `  ${chalk.dim("Sum")}            ${formatTokenCount(sum)} ${chalk.dim("(子总计,best-effort 解析)")}`,
  );
  console.log();
}

function truncateForDisplay(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
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

// ─── 集中渲染订阅装载点 ───

/**
 * 工厂:绑定一个可选的 OutputRenderer 实例,返回符合 DecorateRunBusFn 契约的装饰器。
 *
 * 设计要点:
 *   1. 通过 closure 捕获 renderer —— UI 依赖在工厂层显式注入,而非通过 RunBusContext
 *      字段从 runtime 反向传递,保持 runtime API 与展示层解耦。
 *   2. renderer 缺省时 pauseUI 退化为 no-op:适配 serve / 无 spinner 路径(retry/compact
 *      事件仍然渲染,只是不再驱动 spinner 暂停)。
 *   3. 返回的装饰器在 run 结束 finally 调一次,杜绝 listener 跨 run 累积。
 *
 * 涵盖:
 *   - retry:* (attempt / success / exhausted)
 *   - context:budget_check (仅 pre-compact + warning+ 渲染)
 *   - context:compact_start / context:compact_end
 *   - interrupt:* + llm:stream_event + agent:run_end (经 setupInterruptRendering)
 *   - 子 agent 状态条:tool:call_start/end (经 setupSubAgentStatus,按 meta.lineage
 *     过滤主 Task 调用与子 agent 工具事件,实时显示 [Task#N: <desc>] <最近工具>)
 *
 * 不涵盖(职责正交):
 *   - 数据收集类订阅(如 subscribeCompactAccumulator),归 runtime 主流程
 */
export function createRenderSubscribers(renderer?: OutputRenderer): DecorateRunBusFn {
  // pauseUI 单点派生:有 renderer 即包装 stop(),否则 no-op。
  // 保持下方各订阅回调的形状统一,避免"是否暂停"逻辑下沉到每个 case。
  const pauseUI: () => void = renderer ? () => renderer.stop() : () => {};

  return (ctx) => {
    const { bus } = ctx;
    const unsubs: Array<() => void> = [];

    unsubs.push(bus.on("retry:attempt", (info) => {
      pauseUI();
      renderRetryAttempt(info);
    }));
    unsubs.push(bus.on("retry:success", (info) => {
      pauseUI();
      renderRetrySuccess(info);
    }));
    unsubs.push(bus.on("retry:exhausted", (info) => {
      pauseUI();
      renderRetryExhausted(info);
    }));

    unsubs.push(bus.on("context:budget_check", (info) => {
      if (info.phase !== "pre-compact") return;
      if (info.status === "warning" || info.status === "compact" || info.status === "critical") {
        pauseUI();
        renderBudgetStatus(info);
      }
    }));
    unsubs.push(bus.on("context:compact_start", (info) => {
      pauseUI();
      renderCompactStart(info);
    }));
    unsubs.push(bus.on("context:compact_end", (info) => {
      pauseUI();
      renderCompactEnd(info);
    }));

    const interruptHandle = setupInterruptRendering(bus, pauseUI);
    const subAgentStatusHandle = setupSubAgentStatus(bus, pauseUI);

    return () => {
      for (const u of unsubs) u();
      interruptHandle.dispose();
      subAgentStatusHandle.dispose();
    };
  };
}
