import {
  emptyUsage,
  getTotalInputTokens,
  mergeUsage,
  type TokenUsage,
} from "../types/llm.js";
import type {
  AdvancementExit,
  AdvancementRunReview,
  AdvancementSession,
  ReviewCriterionVerdict,
  ReviewEvidence,
} from "./types.js";

/**
 * 收场事实——completed / exited 时从会话已持久化的结构化 review 序列
 * 一次构建，素材不引入新真相源。用户过夜发任务，醒来看到的是
 * 「推进了 N 轮、完成了 X、卡在 Y」，不是一行退出原因加 transcript 考古。
 */

/** 标准矩阵单行——criterionId 锚定，取最后一次覆盖该条的逐条判定。 */
export interface ClosureCriterionRow {
  readonly criterionId: string;
  readonly text: string;
  /** unreviewed = 会话结束前没有任何 review 覆盖过该条。 */
  readonly verdict: ReviewCriterionVerdict | "unreviewed";
  readonly reason?: string;
  readonly evidenceExcerpt?: string;
}

/** 已尝试的未通过处理策略——failureHandlingId 计数，scenario 从契约反查。 */
export interface ClosureAttemptedStrategy {
  readonly failureHandlingId: string;
  readonly scenario?: string;
  readonly attempts: number;
}

export interface ClosureUsageTotals {
  readonly judge: TokenUsage;
  readonly run: TokenUsage;
  /** 全量口径（规范全量输入 + 输出）单一数值——保险丝计量与成本呈现共用。 */
  readonly totalTokens: number;
}

export interface AdvancementClosureFacts {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly status: AdvancementSession["status"];
  readonly rubricTitle?: string;
  readonly reviewedRunCount: number;
  readonly exit?: AdvancementExit;
  readonly criteria: readonly ClosureCriterionRow[];
  readonly attemptedStrategies: readonly ClosureAttemptedStrategy[];
  /** 最后一次验收采信的证据——completed 的验收证据链素材。 */
  readonly lastEvidence: readonly ReviewEvidence[];
  readonly usage: ClosureUsageTotals;
}

/**
 * 收场报告——summary 可为 LLM 合成或降级直出文本；facts 恒随行，
 * 结构化数据不因合成失败缺席。
 */
export interface AdvancementClosureReport {
  readonly summary: string;
  readonly synthesized: boolean;
  readonly facts: AdvancementClosureFacts;
}

export function buildClosureFacts(
  session: AdvancementSession,
): AdvancementClosureFacts {
  const rubric = session.confirmedRubric;
  const criteria: ClosureCriterionRow[] = (
    rubric?.content.passCriteria ?? []
  ).map((criterion) => {
    const latest = findLatestCriterionAttribution(session.runs, criterion.id);
    return {
      criterionId: criterion.id,
      text: criterion.text,
      verdict: latest?.verdict ?? "unreviewed",
      ...(latest?.reason ? { reason: latest.reason } : {}),
      ...(latest?.evidenceExcerpt
        ? { evidenceExcerpt: latest.evidenceExcerpt }
        : {}),
    };
  });

  const strategyCounts = new Map<string, number>();
  for (const review of session.runs) {
    // 「已试」锚定续推真实发出：failed 落盘与 proxy 入队原子绑定。
    // 保险丝 / dead-end 转化轮的 review 忠实保留裁判的策略选择，但续推
    // 未执行——「本打算尝试」不得投影成「已尝试」。
    if (review.decision !== "failed" || !review.selectedFailureHandlingId) {
      continue;
    }
    strategyCounts.set(
      review.selectedFailureHandlingId,
      (strategyCounts.get(review.selectedFailureHandlingId) ?? 0) + 1,
    );
  }
  const attemptedStrategies: ClosureAttemptedStrategy[] = [
    ...strategyCounts.entries(),
  ].map(([failureHandlingId, attempts]) => {
    const scenario = rubric?.content.failureHandling.find(
      (handling) => handling.id === failureHandlingId,
    )?.scenario;
    return {
      failureHandlingId,
      attempts,
      ...(scenario ? { scenario } : {}),
    };
  });

  const lastReview = session.runs[session.runs.length - 1];
  return {
    sessionId: session.id,
    conversationId: session.conversationId,
    status: session.status,
    ...(rubric?.title ? { rubricTitle: rubric.title } : {}),
    reviewedRunCount: session.runs.length,
    ...(session.exit ? { exit: session.exit } : {}),
    criteria,
    attemptedStrategies,
    lastEvidence: lastReview?.evidence ?? [],
    usage: sumAdvancementUsage(session.runs),
  };
}

/**
 * 沿 review 序列累加 usage 两半快照——单会话保险丝的计量入口，
 * 免于回读 transcript。
 */
export function sumAdvancementUsage(
  runs: readonly AdvancementRunReview[],
): ClosureUsageTotals {
  let judge = emptyUsage();
  let run = emptyUsage();
  for (const review of runs) {
    if (review.usage?.judge) judge = mergeUsage(judge, review.usage.judge);
    if (review.usage?.run) run = mergeUsage(run, review.usage.run);
  }
  const totalTokens =
    getTotalInputTokens(judge) +
    judge.outputTokens +
    getTotalInputTokens(run) +
    run.outputTokens;
  return { judge, run, totalTokens };
}

const VERDICT_LABELS: Record<ClosureCriterionRow["verdict"], string> = {
  met: "已满足",
  unmet: "未满足",
  // 收场矩阵不裸露 unknown——翻译成用户能读懂的采信语义。
  unknown: "无法独立核验，已按执行侧报告采信",
  unreviewed: "未验收",
};

/**
 * 收场报告降级直出——确定性纯文本渲染，不依赖 LLM。
 * LLM 合成失败时它保证退出 / 完成不被阻塞、信息不缺席。
 */
export function renderClosureReport(facts: AdvancementClosureFacts): string {
  const lines: string[] = [];
  const heading =
    facts.status === "completed" ? "任务推进已验收通过" : "任务推进已退出";
  lines.push(
    facts.rubricTitle ? `${heading}：${facts.rubricTitle}` : heading,
  );
  lines.push(`共验收 ${facts.reviewedRunCount} 轮。`);
  if (facts.exit && facts.status !== "completed") {
    lines.push(`退出原因：${facts.exit.message}`);
  }

  if (facts.criteria.length > 0) {
    lines.push("");
    lines.push("【标准矩阵】");
    for (const row of facts.criteria) {
      const parts = [`- ${row.text}：${VERDICT_LABELS[row.verdict]}`];
      if (row.reason) parts.push(row.reason);
      lines.push(parts.join("。"));
      if (row.evidenceExcerpt) {
        lines.push(`  证据：${row.evidenceExcerpt}`);
      }
    }
  }

  if (facts.attemptedStrategies.length > 0) {
    lines.push("");
    lines.push("【已尝试策略】");
    for (const strategy of facts.attemptedStrategies) {
      const label = strategy.scenario ?? strategy.failureHandlingId;
      lines.push(`- ${label}（${strategy.attempts} 次）`);
    }
  }

  if (facts.status === "completed" && facts.lastEvidence.length > 0) {
    lines.push("");
    lines.push("【验收证据】");
    for (const evidence of facts.lastEvidence) {
      lines.push(`- ${evidence.summary}`);
    }
  }

  lines.push("");
  lines.push(`本次推进共消耗约 ${facts.usage.totalTokens} tokens。`);
  return lines.join("\n");
}

/**
 * 收场报告合成 prompt——素材只有结构化收场事实，合成不得引入新真相源。
 * 执行体（complete 函数）由装配层注入，与准入 / 草案生成同构。
 */
export function buildClosureSynthesisPrompt(
  facts: AdvancementClosureFacts,
): string {
  return [
    "你是知行推进侧的收场报告撰写者。根据以下结构化验收事实，为用户写一份简短的收场报告。",
    "只依据给出的事实，不得虚构进度、证据或建议依据；事实里没有的信息不要编。",
    "报告直接回答：推进了几轮、完成了什么、卡在哪里；已完成则给验收依据摘要，未完成则给建议下一步。",
    "verdict 为 unknown 的标准表述为「无法独立核验，已按执行侧报告采信」，不要出现 unknown 字样。",
    "用中文纯文本输出，不用 markdown 标题，不超过 300 字。",
    "",
    "## 验收事实",
    JSON.stringify(facts, null, 2),
  ].join("\n");
}

function findLatestCriterionAttribution(
  runs: readonly AdvancementRunReview[],
  criterionId: string,
) {
  for (let i = runs.length - 1; i >= 0; i--) {
    const found = runs[i]!.attribution.criteria.find(
      (item) => item.criterionId === criterionId,
    );
    if (found) return found;
  }
  return undefined;
}
