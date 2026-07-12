/**
 * 推进呈现 —— 任务推进闭环在 CLI 的全部用户可见文案与投影（纯函数层）。
 *
 * 单一来源纪律：来源标记、退出原因人话、控制事件的系统行文案都在这里，
 * 实时旁观（ObservedTurnPresenter）、历史尾巴（history-tail）与控制面
 * 监听器（AdvancementControlPresenter）三处消费同一份，不各自措辞。
 *
 * 呈现纪律（对齐架构文档 §10 显示规则）：
 * - 来源标记自解释：代理消息明说「知行推进 · 自动续推」，不靠色调暗示；
 * - 判断详情默认折叠：验收只渲染一行判定摘要，逐条归因不上屏；
 * - unknown 不裸露：翻译为「无法独立核验，已按执行侧报告采信」（收场
 *   报告的翻译在 core 渲染层完成，这里只消费 summary）；
 * - 保险丝透明：budget-exceeded 的解释文案随 exit.message 直出。
 */

import chalk from "chalk";
import {
  describeClosureVerdict,
  renderClosureReport,
  type AdvancementExit,
  type AdvancementRunReview,
  type ReviewEvidence,
} from "@zhixing/core";
import type { SessionAdvancementDetailResult } from "@zhixing/rpc";
import { clampLine } from "./tui/line-width.js";
import { layout } from "./tui/style.js";

/** 代理消息的来源标记——实时旁观与历史渲染同源。 */
export const ADVANCEMENT_TURN_LABEL = "知行推进 · 自动续推";

/** 退出原因的人话——收场标题里给用户读的一句话，不裸露枚举值。 */
export function describeAdvancementExitReason(
  reason: AdvancementExit["reason"],
): string {
  switch (reason) {
    case "passed":
      return "验收通过";
    case "dead-end":
      return "继续推进没有新进展";
    case "user-cancelled":
      return "你取消了任务";
    case "user-took-over":
      return "你接管了任务";
    case "superseded":
      return "验收标准已按你的修正重新确认";
    case "system-error":
      return "系统无法继续可靠验收";
    case "capability-gap":
      return "需要你人工验收（超出系统独立核验能力）";
    case "budget-exceeded":
      return "达到单任务成本上限";
    default:
      // wire 数据可能来自更新版本的宿主（新增枚举值）——不裸露原值也
      // 不渲染 undefined，给可读兜底。
      return "推进已结束";
  }
}

/**
 * 一轮验收的单行摘要——「判断详情默认折叠」的落地形态：
 * 只给判定结论 + 达标计数 + 首条未满足项，逐条归因与证据摘录不上屏。
 * round 是会话内验收轮次（wire 随事件下发的 review 计数）——
 * review.runIndex 是对话全局 run 序号，不可作轮次；缺失时不显示轮次。
 */
export function summarizeReview(
  review: AdvancementRunReview,
  round?: number,
): string {
  const label = round !== undefined ? `推进验收 第 ${round} 轮` : "推进验收";
  if (review.decision === "passed") {
    return `${label}：已通过`;
  }
  const counts = countVerdicts(review);
  const ratio =
    counts.total > 0 ? `（${counts.met}/${counts.total} 条达标）` : "";
  if (review.decision === "failed") {
    const firstUnmet = review.unmetCriteria[0];
    const detail = firstUnmet ? `——${firstUnmet}` : "";
    return `${label}：未通过${ratio}${detail}`;
  }
  return `${label}：判定退出${ratio}`;
}

function countVerdicts(review: AdvancementRunReview): {
  met: number;
  total: number;
} {
  let met = 0;
  let total = 0;
  for (const item of review.attribution.criteria) {
    total++;
    if (item.verdict === "met") met++;
  }
  return { met, total };
}

/**
 * 控制事件 → 终端系统行（纯函数）。空数组 = 该事件不在 CLI 呈现。
 *
 * 呈现取舍：
 * - contract_*（草案 / 确认 / 取消 / 失败）不在此渲染——契约确认是发起端
 *   行为，由 send 返回值驱动的确认面与同步提示承载，事件重放会双渲染；
 * - decision 为 exit 的 run_reviewed 不单独出行——紧随的 exited 事件
 *   携收场报告，一处收束；
 * - payload 是 wire 数据，防御性解析，形状不符静默跳过（呈现层绝不抛错）。
 */
export function renderAdvancementControlEventLines(
  event: string,
  payload: unknown,
  width: number,
): string[] {
  switch (event) {
    case "advancement:run_reviewed": {
      const review = isRecord(payload) ? payload["review"] : undefined;
      if (!isReviewShape(review)) return [];
      if (review.decision === "exit") return [];
      const roundValue = isRecord(payload) ? payload["reviewRound"] : undefined;
      const round = typeof roundValue === "number" ? roundValue : undefined;
      // 摘要行带首条未满足项；其余卡点逐条缩进列出——用户看全卡点，
      // 逐条归因与证据摘录折叠，展开入口是 /advancement。
      return [
        systemLine(
          `${summarizeReview(review, round)} · /advancement 看详情`,
          width,
        ),
        ...review.unmetCriteria
          .slice(1)
          .map((unmet) =>
            line(chalk.dim(`${layout.contentPrefix}  · ${unmet}`), width),
          ),
      ];
    }
    case "advancement:proxy_enqueued":
      return [systemLine(`${ADVANCEMENT_TURN_LABEL} · 将自动继续`, width)];
    case "advancement:completed": {
      const summary = closureSummaryOf(payload);
      return [
        line(chalk.green(`${layout.contentPrefix}✓ 任务推进完成`), width),
        ...summaryLines(summary, width),
      ];
    }
    case "advancement:exited": {
      const reason = exitReasonOf(payload);
      const title = reason
        ? `推进已退出：${describeAdvancementExitReason(reason)}`
        : "推进已退出";
      const summary = closureSummaryOf(payload);
      return [systemLine(title, width), ...summaryLines(summary, width)];
    }
    case "advancement:review_deferred": {
      const cause = isRecord(payload) ? payload["cause"] : undefined;
      return [
        systemLine(
          cause === "aborted"
            ? "本轮验收已中止"
            : "本轮验收暂缓（稍后自动补审）",
          width,
        ),
      ];
    }
    case "advancement:proxy_recovered":
      return [systemLine("已恢复未完成的推进，继续执行", width)];
    case "advancement:recovery_failed": {
      const message = isRecord(payload) ? payload["message"] : undefined;
      const detail = typeof message === "string" && message ? `：${message}` : "";
      return [
        line(chalk.yellow(`${layout.contentPrefix}⚠ 推进恢复失败${detail}`), width),
      ];
    }
    default:
      return [];
  }
}

/**
 * /advancement 详情呈现——「判断详情默认折叠、可展开」的展开面。
 * open 会话给标准矩阵逐条归因（判定人话 + 理由 + 证据摘录）、采信证据、
 * 已试策略与消耗；终态会话直出收场报告（离线错过收场事件后的回看）。
 * 素材全部来自宿主已持久化事实，呈现层不引入新真相源。
 */
export function renderAdvancementDetailLines(
  result: SessionAdvancementDetailResult,
  width: number,
): string[] {
  const detail = result.detail;
  if (!detail) {
    return [systemLine("当前对话没有推进任务记录。", width)];
  }
  const { facts } = detail;

  if (detail.status !== "active" && detail.status !== "awaiting-rubric-confirmation") {
    // 终态回看：收场报告随查随算直出（unknown 人话已在 core 渲染层翻译）
    const header =
      detail.status === "cancelled" ? "推进任务已取消" : undefined;
    return [
      ...(header ? [systemLine(header, width)] : []),
      ...renderClosureReport(facts)
        .split("\n")
        .map((row) => line(chalk.dim(`${layout.contentPrefix}${row}`), width)),
    ];
  }

  const lines: string[] = [];
  const title = detail.rubricTitle ? `：${detail.rubricTitle}` : "";
  const state =
    detail.status === "active"
      ? `进行中 · 已验收 ${facts.reviewedRunCount} 轮`
      : "等待确认验收标准";
  lines.push(systemLine(`任务推进${title}（${state}）`, width));

  if (facts.criteria.length > 0) {
    lines.push(dimLine("【标准矩阵 · 最近判定】", width));
    facts.criteria.forEach((row, index) => {
      const parts = [`${index + 1}. ${row.text}：${describeClosureVerdict(row.verdict)}`];
      if (row.reason) parts.push(row.reason);
      lines.push(dimLine(`  ${parts.join("。")}`, width));
      if (row.evidenceExcerpt) {
        lines.push(dimLine(`     证据：${row.evidenceExcerpt}`, width));
      }
    });
  }

  const evidence = detail.lastReview?.evidence ?? [];
  if (evidence.length > 0) {
    lines.push(dimLine("【最近一轮采信证据】", width));
    for (const item of evidence) {
      lines.push(
        dimLine(`  - ${item.summary}（${describeEvidenceSource(item)}）`, width),
      );
    }
  }

  if (facts.attemptedStrategies.length > 0) {
    lines.push(dimLine("【已尝试策略】", width));
    for (const strategy of facts.attemptedStrategies) {
      lines.push(
        dimLine(
          `  - ${strategy.scenario ?? strategy.failureHandlingId}（${strategy.attempts} 次）`,
          width,
        ),
      );
    }
  }

  lines.push(dimLine(`本次推进已消耗约 ${facts.usage.totalTokens} tokens。`, width));
  return lines;
}

function describeEvidenceSource(evidence: ReviewEvidence): string {
  switch (evidence.source) {
    case "independent":
      return "独立核验";
    case "user":
      return "用户提供";
    default:
      return "执行侧报告";
  }
}

function dimLine(text: string, width: number): string {
  return line(chalk.dim(`${layout.contentPrefix}${text}`), width);
}

/**
 * 恢复对话时的推进状态提示行——awaiting 主动浮现的前导、active 的知情。
 * 快照来自 resume / list 的 wire 投影，形状由 wire 契约保证。
 */
export function renderResumedAdvancementNotice(
  snapshot: {
    readonly status: "awaiting-rubric-confirmation" | "active";
    readonly rubricTitle?: string;
    readonly lastReview?: { readonly round: number };
  },
  width: number,
): string {
  if (snapshot.status === "awaiting-rubric-confirmation") {
    return systemLine("该对话有待确认的推进任务", width);
  }
  const title = snapshot.rubricTitle ? `：${snapshot.rubricTitle}` : "";
  const rounds =
    snapshot.lastReview !== undefined
      ? `（已验收 ${snapshot.lastReview.round} 轮）`
      : "";
  return systemLine(`该对话的任务推进进行中${title}${rounds}`, width);
}

function systemLine(text: string, width: number): string {
  return line(chalk.dim(`${layout.contentPrefix}◆ ${text}`), width);
}

function line(text: string, width: number): string {
  return clampLine(text, Math.max(20, width));
}

/** 收场报告 summary 多行渲染——按行 dim + 缩进，保持 core 直出的段落结构。 */
function summaryLines(summary: string | undefined, width: number): string[] {
  if (!summary) return [];
  return summary
    .split("\n")
    .map((row) => line(chalk.dim(`${layout.contentPrefix}  ${row}`), width));
}

function closureSummaryOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const closure = payload["closure"];
  if (!isRecord(closure)) return undefined;
  const summary = closure["summary"];
  return typeof summary === "string" && summary.trim() ? summary : undefined;
}

function exitReasonOf(payload: unknown): AdvancementExit["reason"] | undefined {
  if (!isRecord(payload)) return undefined;
  const exit = payload["exit"];
  if (!isRecord(exit)) return undefined;
  const reason = exit["reason"];
  return typeof reason === "string"
    ? (reason as AdvancementExit["reason"])
    : undefined;
}

function isReviewShape(value: unknown): value is AdvancementRunReview {
  if (!isRecord(value)) return false;
  return (
    typeof value["runIndex"] === "number" &&
    typeof value["decision"] === "string" &&
    isRecord(value["attribution"]) &&
    Array.isArray((value["attribution"] as Record<string, unknown>)["criteria"]) &&
    Array.isArray(value["unmetCriteria"])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
