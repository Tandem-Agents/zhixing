import type {
  ConfirmedRubricContentSnapshot,
  PassCriterionSnapshot,
  ReviewAttribution,
  ReviewCriterionAttribution,
} from "./types.js";

/**
 * 归因的确定性渲染与投影派生。
 *
 * 归因事实块随代理消息下发执行侧：failureHandling 模板守住推进意图不被改写，
 * 归因块把裁判的逐条结论与独立证据事实传过去——两者拼装即代理消息全文。
 * 渲染必须是纯函数：恢复重建代理消息时按同一 attribution 重渲染，
 * content 与原始产物 byte 等价。
 */

const VERDICT_LABELS: Record<ReviewCriterionAttribution["verdict"], string> = {
  met: "已满足",
  unmet: "未满足",
  unknown: "无法独立核验，按执行侧报告采信",
};

/** 按快照条目顺序渲染归因事实块；criteria 缺失（系统兜底 review）返回空串。 */
export function renderReviewAttribution(
  attribution: ReviewAttribution,
  passCriteria: readonly PassCriterionSnapshot[],
): string {
  if (attribution.criteria.length === 0) return "";
  const byId = new Map(attribution.criteria.map((item) => [item.criterionId, item]));
  const lines: string[] = ["【验收判定】"];
  for (const criterion of passCriteria) {
    const verdict = byId.get(criterion.id);
    if (!verdict) continue;
    lines.push(
      `- ${criterion.text}：${VERDICT_LABELS[verdict.verdict]}。${verdict.reason}`,
    );
    if (verdict.evidenceExcerpt) {
      lines.push(`  证据：${verdict.evidenceExcerpt}`);
    }
  }
  return lines.join("\n");
}

/** attribution 中 unmet 条目的标准文本投影——unmetCriteria 字段的唯一构造来源。 */
export function deriveUnmetCriteriaTexts(
  attribution: ReviewAttribution,
  passCriteria: readonly PassCriterionSnapshot[],
): string[] {
  const textById = new Map(passCriteria.map((item) => [item.id, item.text]));
  return attribution.criteria
    .filter((item) => item.verdict === "unmet")
    .map((item) => textById.get(item.criterionId) ?? item.criterionId);
}

/**
 * 渲染契约验收条件块——推进会话 active 期间经 run 瞬态注入对执行侧每 run 可见。
 * 公开面只含通过标准与证据要求（执行侧知道要核验什么，才会主动产出可核验的证据）；
 * failureHandling 与裁判过程不在其中。
 */
export function renderAcceptanceConditions(
  content: ConfirmedRubricContentSnapshot,
): string {
  const lines: string[] = [
    "本任务经用户确认的验收条件（完成判定以此为准，由推进侧独立核验）：",
  ];
  for (const criterion of content.passCriteria) {
    lines.push(`- ${criterion.text}`);
  }
  const requirements = content.evidenceRequirements ?? [];
  if (requirements.length > 0) {
    lines.push("验收时将核对以下证据：");
    for (const requirement of requirements) {
      // 必需性与核验路径是证据契约的一部分——执行侧知道产物会在哪被核验，
      // 才能把产物放对地方；与确认面展示的信息保持同一口径。
      const required = requirement.required === true ? "必需" : "可选";
      const located = requirement.locator?.paths?.length
        ? `，核验路径：${requirement.locator.paths.join("、")}`
        : "";
      lines.push(`- ${requirement.description}（${required}${located}）`);
    }
  }
  return lines.join("\n");
}
