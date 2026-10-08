/** Shared run notices: usable by the headless Host without loading terminal UI. */
import chalk from "chalk";
import type { AgentEventMap, IEventBus } from "@zhixing/core";
import type { DecorateRunBusFn } from "@zhixing/orchestrator/runtime";
import { PERSPECTIVES_CONVERGENCE_NODE_ID, PERSPECTIVES_DELIBERATION_DEFINITION_ID } from "@zhixing/core/conversation/application";
import type { CliWriter } from "./screen/index.js";
import { ANCHOR_SUB_AGENT } from "./output/speaker-state.js";
import { renderAuditEvent } from "./security/audit-event-renderer.js";
import { createLifecycleWarningDeduper, renderLifecycleWarningLine, type LifecycleWarningDeduper } from "./lifecycle-diagnostics-presentation.js";

export interface CreateRunEventSubscribersOptions {
  readonly renderer?: { stop(): void };
  readonly writer: CliWriter;
  readonly lifecycleWarningDeduper?: LifecycleWarningDeduper;
}

function isMainLineage(meta?: { lineage?: string }): boolean {
  return meta?.lineage === undefined || meta.lineage === "main";
}

function isSubLineage(meta?: { lineage?: string }): boolean {
  return typeof meta?.lineage === "string" && meta.lineage.startsWith("main/sub-");
}

// ─── 中断 EventBus 渲染编排 ───

/**
 * 中断渲染装载句柄。run 结束时调 dispose 卸载 listener,避免跨 run 累积。
 */
export interface InterruptRenderingHandle {
  dispose(): void;
}

/** One-shot interruption notices for line-output consumers.
 * Live terminal activity is projected separately by N. */
export function setupInterruptRendering(
  eventBus: IEventBus<AgentEventMap>,
  pauseUI: () => void,
  writer: CliWriter,
): InterruptRenderingHandle {
  const onWarn = (e: AgentEventMap["interrupt:warn"], meta?: { lineage?: string }) => {
    if (!isMainLineage(meta)) return;
    pauseUI();
    const remaining = Math.max(0, Math.ceil((e.timeoutMs - e.elapsedMs) / 1000));
    // 用 notify：表达"任意时刻可能触发"的语义，与同步段落 line 区分
    writer.notify(
      chalk.yellow(
        `  ⚠ stream slow, will auto-cancel in ${remaining}s if no response`,
      ),
    );
  };

  const onFired = (_e: AgentEventMap["interrupt:fired"], meta?: { lineage?: string }) => {
    if (!isMainLineage(meta)) return;
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

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function renderPerspectiveProgress(
  pauseUI: () => void,
  writer: CliWriter,
  text: string,
): void {
  pauseUI();
  writer.ensureSegmentBreak();
  writer.line(chalk.dim(`  ◇ ${text}`));
}

function renderSubtaskAuditLine(line: string): string {
  return `  ${chalk.dim(ANCHOR_SUB_AGENT)} ${chalk.dim("子任务安全事件")} ${line.trimStart()}`;
}

/**
 * 工厂——返回符合 DecorateRunBusFn 契约的装饰器，装载所有 EventBus 订阅型渲染。
 *
 * 设计要点:
 *   1. UI 依赖在工厂层显式注入（writer / renderer），而非通过 RunBusContext
 *      反向传递，保持 runtime API 与展示层解耦。
 *   2. writer 是必选——所有渲染必须经 CliWriter 协调，避免直接 console.log 推走 chrome。
 *   3. renderer 缺省时 pauseUI 退化为 no-op：适配 serve 等非交互路径（retry / compact
 *      事件仍然渲染，只是不再驱动 OutputRenderer 暂停）。
 *   4. 返回的装饰器在 run 结束 finally 调一次，杜绝 listener 跨 run 累积。
 */
export function createRunEventSubscribers(
  options: CreateRunEventSubscribersOptions,
): DecorateRunBusFn {
  const { renderer, writer } = options;
  const lifecycleWarningDeduper =
    options.lifecycleWarningDeduper ?? createLifecycleWarningDeduper();
  // pauseUI 单点派生：有 renderer 即包装 stop()，否则 no-op
  const pauseUI: () => void = renderer ? () => renderer.stop() : () => {};

  return (ctx) => {
    const { bus } = ctx;
    const unsubs: Array<() => void> = [];

    unsubs.push(
      bus.on("retry:attempt", (info, meta) => {
        if (!isMainLineage(meta)) return;
        pauseUI();
        renderRetryAttempt(info, writer);
      }),
    );
    unsubs.push(
      bus.on("retry:success", (info, meta) => {
        if (!isMainLineage(meta)) return;
        pauseUI();
        renderRetrySuccess(info, writer);
      }),
    );
    unsubs.push(
      bus.on("retry:exhausted", (info, meta) => {
        if (!isMainLineage(meta)) return;
        pauseUI();
        renderRetryExhausted(info, writer);
      }),
    );

    unsubs.push(
      bus.on("segment:transition_start", (info, meta) => {
        if (!isMainLineage(meta)) return;
        pauseUI();
        renderSegmentStart(info, writer);
      }),
    );
    unsubs.push(
      bus.on("segment:emergency_floor", (info, meta) => {
        if (!isMainLineage(meta)) return;
        pauseUI();
        renderEmergencyFloor(info, writer);
      }),
    );
    unsubs.push(
      bus.on("segment:new_started", (info, meta) => {
        if (!isMainLineage(meta)) return;
        pauseUI();
        renderSegmentEnd(info, writer);
      }),
    );
    unsubs.push(
      bus.on("segment:transition_failed", (info, meta) => {
        if (!isMainLineage(meta)) return;
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
      bus.on("security:steward_review", (payload, meta) => {
        const line = renderAuditEvent({ type: "steward_review", payload });
        if (!line) return;
        pauseUI();
        writer.ensureSegmentBreak();
        writer.line(isSubLineage(meta) ? renderSubtaskAuditLine(line) : line);
      }),
    );
    unsubs.push(
      bus.on("security:rule_sedimented", (payload, meta) => {
        const line = renderAuditEvent({ type: "rule_sedimented", payload });
        if (!line) return;
        pauseUI();
        writer.ensureSegmentBreak();
        writer.line(isSubLineage(meta) ? renderSubtaskAuditLine(line) : line);
      }),
    );

    // 运行体生命周期钩子（run 内）—— hook_failed 是失败安全网；warning 是
    // 订阅者主动报告的软降级，用户需要知道本轮上下文约定是否完整生效。
    unsubs.push(
      bus.on("lifecycle:hook_failed", (info, meta) => {
        if (!isMainLineage(meta)) return;
        pauseUI();
        writer.line(
          `  ${chalk.yellow("⚠")} ${chalk.dim(`生命周期钩子 ${info.hookId} 在 ${info.phase} 失败: ${info.error}`)}`,
        );
      }),
    );
    unsubs.push(
      bus.on("lifecycle:warning", (info, meta) => {
        if (!isMainLineage(meta)) return;
        if (!lifecycleWarningDeduper.shouldShow(info)) return;
        pauseUI();
        writer.ensureSegmentBreak();
        writer.line(renderLifecycleWarningLine(info));
      }),
    );
    unsubs.push(
      bus.on("lifecycle:prompt_rebuilt", (info, meta) => {
        if (!isMainLineage(meta)) return;
        pauseUI();
        writer.line(
          chalk.dim(`  ⟳ 系统提示词已随注意力窗口重建 (${info.reason})`),
        );
      }),
    );

    const perspectiveProgress = {
      runId: "",
      crossStarted: false,
      convergenceStarted: false,
    };
    unsubs.push(
      bus.on("orchestration:run_start", (info) => {
        if (info.definitionId !== PERSPECTIVES_DELIBERATION_DEFINITION_ID) {
          return;
        }
        perspectiveProgress.runId = info.runId;
        perspectiveProgress.crossStarted = false;
        perspectiveProgress.convergenceStarted = false;
        renderPerspectiveProgress(
          pauseUI,
          writer,
          `多视角评议：${info.nodeCount} 个节点开始协作`,
        );
      }),
    );
    unsubs.push(
      bus.on("orchestration:node_start", (info) => {
        if (
          info.definitionId !== PERSPECTIVES_DELIBERATION_DEFINITION_ID ||
          info.runId !== perspectiveProgress.runId
        ) {
          return;
        }
        if (
          info.nodeId.startsWith("cross-") &&
          !perspectiveProgress.crossStarted
        ) {
          perspectiveProgress.crossStarted = true;
          renderPerspectiveProgress(pauseUI, writer, "交叉吸收中");
        }
        if (
          info.nodeId === PERSPECTIVES_CONVERGENCE_NODE_ID &&
          !perspectiveProgress.convergenceStarted
        ) {
          perspectiveProgress.convergenceStarted = true;
          renderPerspectiveProgress(pauseUI, writer, "收敛最终版本中");
        }
      }),
    );
    unsubs.push(
      bus.on("orchestration:run_end", (info) => {
        if (
          info.definitionId !== PERSPECTIVES_DELIBERATION_DEFINITION_ID ||
          info.runId !== perspectiveProgress.runId ||
          info.status === "completed"
        ) {
          return;
        }
        renderPerspectiveProgress(
          pauseUI,
          writer,
          `多视角评议未完成：${info.error ?? info.status}`,
        );
      }),
    );

    const interruptHandle = setupInterruptRendering(bus, pauseUI, writer);

    return () => {
      for (const u of unsubs) u();
      interruptHandle.dispose();
    };
  };
}
