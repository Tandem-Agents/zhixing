/**
 * 终端渲染模块——AI 输出区主流程之外的辅助渲染。
 *
 * 主流程的 AgentYield 流（text / thinking / tool / turn_complete）由 output/ 子模块
 * 的 createOutputRenderer 接管；本文件保留剩余的"非流式"渲染：
 *   - renderError：catch 路径 unexpected 异常的兜底
 *   - renderUsageReport / renderContextVisual：/usage 与 /context 命令的可视化
 *   - renderRetry* / renderSegment*：EventBus 订阅型事件渲染
 *   - setupInterruptRendering：中断 EventBus 订阅渲染（warn 单次提示 / fired [interrupted] 标记）
 *   - createRenderSubscribers：装载 EventBus 渲染订阅的工厂
 *   - formatAbortReasonSummary：abort 原因诊断文本（供 status-bar / log 共用）
 *
 * 注：turn 终止反馈（completed / aborted / error / max_turns 摘要）由 status-bar 单点
 * 接管——renderSummary 已移除。status-bar done 状态永驻显示直到下一次 run_start。
 *
 * 写屏统一经 CliWriter——caller 注入 ScreenWriter（cli REPL 模式协调 chrome）或
 * StdoutWriter（serve / 非交互），渲染函数本身不关心后端。这是 chrome 持久不变量的
 * 类型层强制：函数签名要求 writer 参数，禁止内部直接 console.log / process.stdout.write。
 */

import chalk from "chalk";
import {
  type AbortReason,
  type AgentEventMap,
  type ContextBudget,
  type IEventBus,
} from "@zhixing/core";
import type { DecorateRunBusFn } from "@zhixing/orchestrator/runtime";
import type { RuntimeSubAgentUsageEntry } from "@zhixing/server";
import type { OutputRenderer } from "./output/index.js";
import type { CliWriter, ScreenController } from "./screen/index.js";
import {
  createStatusBar,
  type StatusBarHandle,
} from "./status-bar/index.js";
import { attachChunkDumpToBus } from "./output/index.js";
import { renderAuditEvent } from "./security/terminal-renderer.js";
import {
  createContextIndicator,
  type ContextIndicatorHandle,
} from "./context-indicator/index.js";

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

// ─── 中断 EventBus 渲染编排 ───

/**
 * 中断渲染装载句柄。run 结束时调 dispose 卸载 listener,避免跨 run 累积。
 */
export interface InterruptRenderingHandle {
  dispose(): void;
}

/**
 * 装载 EventBus 中断事件 → 终端可视反馈：
 *
 * - `interrupt:warn` → 单次写一行警告 "stream slow, will auto-cancel in Ns..."。
 *   实时倒计时由 status-bar 接管（订阅 interrupt:warn 在状态条按 250ms tick 刷新
 *   remainSec）；此处只做"突起的一次性提示行"让用户在 status-bar 之外也注意到。
 *
 * - `interrupt:fired` → 写 dim `[interrupted]` 视觉标记。reason 文本由 status-bar
 *   在 done 状态展示（关注点分离：fired 是 abort 瞬间的视觉锚点，done 状态展示完整原因）。
 *
 * 返回 dispose 函数，调用方在 run() 结束 finally 调一次。
 */
export function setupInterruptRendering(
  eventBus: IEventBus<AgentEventMap>,
  pauseUI: () => void,
  writer: CliWriter,
): InterruptRenderingHandle {
  const onWarn = (e: AgentEventMap["interrupt:warn"]) => {
    pauseUI();
    const remaining = Math.max(0, Math.ceil((e.timeoutMs - e.elapsedMs) / 1000));
    // 用 notify：表达"任意时刻可能触发"的语义，与同步段落 line 区分
    writer.notify(
      chalk.yellow(
        `  ⚠ stream slow, will auto-cancel in ${remaining}s if no response`,
      ),
    );
  };

  const onFired = (_e: AgentEventMap["interrupt:fired"]) => {
    pauseUI();
    // dim [interrupted] 接在 LLM 文本之后形成视觉连续
    writer.line(chalk.dim("[interrupted]"));
  };

  eventBus.on("interrupt:warn", onWarn);
  eventBus.on("interrupt:fired", onFired);

  return {
    dispose() {
      eventBus.off("interrupt:warn", onWarn);
      eventBus.off("interrupt:fired", onFired);
    },
  };
}

// ─── 重试事件渲染 ───

/** 渲染重试尝试提示（黄色警告） */
export function renderRetryAttempt(
  info: {
    errorType: string;
    attempt: number;
    maxRetries: number;
    delayMs: number;
  },
  writer: CliWriter,
): void {
  const delayStr = (info.delayMs / 1000).toFixed(1);
  writer.line(
    `\n  ${chalk.yellow("⚠")} ${chalk.yellow(formatErrorType(info.errorType))}` +
      `${chalk.dim(`, 第 ${info.attempt}/${info.maxRetries} 次重试，等待 ${delayStr}s...`)}`,
  );
}

/** 渲染重试成功提示（绿色） */
export function renderRetrySuccess(
  info: { attemptsTaken: number },
  writer: CliWriter,
): void {
  writer.line(
    `\n  ${chalk.green("✓")} ${chalk.dim(`重试成功（第 ${info.attemptsTaken} 次）`)}`,
  );
}

/** 渲染重试耗尽提示（红色） */
export function renderRetryExhausted(
  info: {
    totalAttempts: number;
    lastError: string;
  },
  writer: CliWriter,
): void {
  writer.line(
    `\n  ${chalk.red("✗")} ${chalk.red(`重试耗尽（共 ${info.totalAttempts} 次）`)}: ${chalk.dim(info.lastError)}`,
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

// ─── 段切换渲染 ───

/** 渲染段切换开始锚点（自动评估触发 / 手动 /compact 不经此——后者走命令反馈） */
export function renderSegmentStart(
  info: { currentTokens: number },
  writer: CliWriter,
): void {
  const tokens = formatTokenCount(info.currentTokens);
  writer.line(
    `  ${chalk.yellow("⟳")} ${chalk.yellow("整理上下文中")} ${chalk.dim(`(${tokens} tokens)`)}`,
  );
}

/** 渲染段切换完成（新段已开始，含应急地板的机械降级形态） */
export function renderSegmentEnd(
  info: { tokensBefore: number; tokensAfter: number },
  writer: CliWriter,
): void {
  const before = formatTokenCount(info.tokensBefore);
  const after = formatTokenCount(info.tokensAfter);
  const savedPct =
    info.tokensBefore > 0
      ? Math.round(((info.tokensBefore - info.tokensAfter) / info.tokensBefore) * 100)
      : 0;
  writer.line(
    `  ${chalk.green("✓")} ${chalk.dim(`上下文已整理: ${before} → ${after} (节省 ${savedPct}%)`)}`,
  );
}

/** 渲染段切换终态失败（本轮没切，不阻塞对话——下轮再评估）。
 *  事件即终态：应急地板兜底成功不走此处（发 emergency_floor + new_started），
 *  本渲染与"已整理"绝不在同一次切换中同时出现。 */
export function renderSegmentFailed(
  info: { error: string },
  writer: CliWriter,
): void {
  writer.line(
    `  ${chalk.yellow("⚠")} ${chalk.dim(`上下文整理失败（不影响对话）: ${info.error}`)}`,
  );
}

/** 渲染应急地板降级警示 —— 摘要服务不可用、已机械保留最近对话。
 *  紧随其后的 new_started 渲染"已整理"结果行：先方式与代价、后结果，
 *  对用户诚实呈现这次整理是有损截断而非正常摘要。 */
export function renderEmergencyFloor(
  info: { droppedTurns: number; error: string },
  writer: CliWriter,
): void {
  writer.line(
    `  ${chalk.yellow("⚠")} ${chalk.dim(`摘要服务不可用（${info.error}），已应急保留最近对话，较早的 ${info.droppedTurns} 轮已截断（完整原文在对话历史中）`)}`,
  );
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
    renderSubAgentUsageSection(subUsages, writer);
  } else {
    writer.line("");
  }
}

/**
 * 把 RuntimeSubAgentUsageEntry 数组渲染成 /usage 的"子 agent 拆分"段。
 *
 * 排版决策:
 *   - description 截断到 28 字符避免单行过长(中文 / emoji 计算用字符数,v1 简化)
 *   - 状态字段(toolUses / durationMs)仅 succeeded 显示;failed / aborted 显示 status 文字
 *   - durationMs → 秒(2 位小数),用户感知尺度优于毫秒原值
 */
function renderSubAgentUsageSection(
  entries: readonly RuntimeSubAgentUsageEntry[],
  writer: CliWriter,
): void {
  writer.line(chalk.dim("  ─────────────────────────────"));
  writer.line(
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
        parts.push(
          `${entry.toolUses} tool_use${entry.toolUses === 1 ? "" : "s"}`,
        );
      }
      if (entry.durationMs !== undefined) {
        parts.push(`${(entry.durationMs / 1000).toFixed(2)}s`);
      }
      extra = parts.length > 0 ? chalk.dim(`  (${parts.join(", ")})`) : "";
    } else {
      extra = chalk.dim(`  (${entry.status})`);
    }

    writer.line(
      `  ${chalk.cyan("+")} Task#${entry.index} ${chalk.dim(`(${desc})`)}  ${icon} ${tokensFmt}${extra}`,
    );
  }

  const sum = entries.reduce((acc, e) => acc + e.tokens, 0);
  writer.line(chalk.dim("  ─────────────────────────────"));
  writer.line(
    `  ${chalk.dim("Sum")}            ${formatTokenCount(sum)} ${chalk.dim("(子总计,best-effort 解析)")}`,
  );
  writer.line("");
}

function truncateForDisplay(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
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
}

/**
 * 工厂——返回符合 DecorateRunBusFn 契约的装饰器，装载所有 EventBus 订阅型渲染。
 *
 * 设计要点:
 *   1. UI 依赖在工厂层显式注入（writer / renderer / screen），而非通过 RunBusContext
 *      反向传递，保持 runtime API 与展示层解耦。
 *   2. writer 是必选——所有渲染必须经 CliWriter 协调，避免直接 console.log 推走 chrome。
 *   3. renderer 缺省时 pauseUI 退化为 no-op：适配 serve 等非交互路径（retry / compact
 *      事件仍然渲染，只是不再驱动 OutputRenderer 暂停）。
 *   4. screen 缺省时 status-bar 不启用——非交互路径的事件渲染仍然有效，
 *      只是不显示动态状态条。
 *   5. 返回的装饰器在 run 结束 finally 调一次，杜绝 listener 跨 run 累积。
 */
export function createRenderSubscribers(
  options: CreateRenderSubscribersOptions,
): DecorateRunBusFn {
  const { renderer, writer, screen } = options;
  // pauseUI 单点派生：有 renderer 即包装 stop()，否则 no-op
  const pauseUI: () => void = renderer ? () => renderer.stop() : () => {};

  return (ctx) => {
    const { bus } = ctx;
    const unsubs: Array<() => void> = [];

    unsubs.push(
      bus.on("retry:attempt", (info) => {
        pauseUI();
        renderRetryAttempt(info, writer);
      }),
    );
    unsubs.push(
      bus.on("retry:success", (info) => {
        pauseUI();
        renderRetrySuccess(info, writer);
      }),
    );
    unsubs.push(
      bus.on("retry:exhausted", (info) => {
        pauseUI();
        renderRetryExhausted(info, writer);
      }),
    );

    unsubs.push(
      bus.on("segment:transition_start", (info) => {
        pauseUI();
        renderSegmentStart(info, writer);
      }),
    );
    unsubs.push(
      bus.on("segment:emergency_floor", (info) => {
        pauseUI();
        renderEmergencyFloor(info, writer);
      }),
    );
    unsubs.push(
      bus.on("segment:new_started", (info) => {
        pauseUI();
        renderSegmentEnd(info, writer);
      }),
    );
    unsubs.push(
      bus.on("segment:transition_failed", (info) => {
        pauseUI();
        renderSegmentFailed(info, writer);
      }),
    );

    // 安全审计事件订阅 —— 让 AI 安全助理的自动放行（safe）与自动沉淀那一刻
    // （rule_sedimented）对用户透明。needs-confirm / escalate 不在此渲染：前者由
    // confirm 面板的前置标识承担，后者由 SecurityBlockError 错误界面承担。
    //
    // 段间空行用 writer.ensureSegmentBreak() —— intent-driven API，让底层（chrome /
    // 直写双模式）各自做幂等：chrome 模式按 cursor 行级状态 emit 1 空行；直写模式
    // no-op。比 helper 内 `\n` 字面量更解耦：未来段间策略调整在 writer 一处变更。
    unsubs.push(
      bus.on("security:steward_review", (payload) => {
        const line = renderAuditEvent({ type: "steward_review", payload });
        if (!line) return;
        pauseUI();
        writer.ensureSegmentBreak();
        writer.line(line);
      }),
    );
    unsubs.push(
      bus.on("security:rule_sedimented", (payload) => {
        const line = renderAuditEvent({ type: "rule_sedimented", payload });
        if (!line) return;
        pauseUI();
        writer.ensureSegmentBreak();
        writer.line(line);
      }),
    );

    // 运行体生命周期钩子（run 内）—— hook_failed 是失败安全网（内置 skill 重建
    // 每窗静默失败会让索引永久陈旧却无人知,故必须用户可见）;prompt_rebuilt 是
    // 系统提示词随窗口重建的轻提示。
    unsubs.push(
      bus.on("lifecycle:hook_failed", (info) => {
        pauseUI();
        writer.line(
          `  ${chalk.yellow("⚠")} ${chalk.dim(`生命周期钩子 ${info.hookId} 在 ${info.phase} 失败: ${info.error}`)}`,
        );
      }),
    );
    unsubs.push(
      bus.on("lifecycle:prompt_rebuilt", (info) => {
        pauseUI();
        writer.line(
          chalk.dim(`  ⟳ 系统提示词已随注意力窗口重建 (${info.reason})`),
        );
      }),
    );

    const interruptHandle = setupInterruptRendering(bus, pauseUI, writer);

    // 注入 screen 时启用动态状态展示组件 —— status-bar (spinner / sub-agent 嵌套)
    // + context-indicator (状态条尾部 "context" 段，合成 "~ Xk (cache Yk)")。
    //
    // 单一启用条件 = `if (screen)`：与 status-bar 同模式，无 chrome 的运行模式
    // （serve 等）自然不装配两者。不引入额外 ENV / CLI flag —— 常态化展示，
    // 数据可用性自然降级（详见 context-indicator.ts docstring "自然降级"段）。
    //
    // tail 段视觉顺序「[task] │ [context]」由 STATUS_TAIL_IDS 声明顺序唯一决定
    // （ScreenController.joinStatusTails 按此裁决），与本处装配顺序、各 source
    // 运行时首次 emit 时序均无关 —— 此处装配顺序仅影响 listener 注册，不影响布局。
    let statusBar: StatusBarHandle | null = null;
    let contextIndicator: ContextIndicatorHandle | null = null;
    if (screen) {
      statusBar = createStatusBar({ screen, eventBus: bus });
      contextIndicator = createContextIndicator({ screen, eventBus: bus });
    }

    // chunk-dump 诊断旁路——`--log` 启用时把 LLM stream 完整事件流（含
    // tool_call_delta 等）写日志，默认 noop 零开销。在 EventBus 订阅装载点接入
    // 而非 output-renderer，覆盖范围与 status-bar 同源（StreamEvent）
    const detachChunkDump = attachChunkDumpToBus(bus);

    return () => {
      for (const u of unsubs) u();
      interruptHandle.dispose();
      statusBar?.dispose();
      contextIndicator?.dispose();
      detachChunkDump();
    };
  };
}
