import {
  RUBRIC_NEARBY_SCORE_THRESHOLD,
  type RubricContractDraftSnapshot,
} from "@zhixing/core";
import type { SelectionRequest } from "../tui/selection/index.js";

export type AdvancementContractSelectionValue =
  | "confirm"
  | "update-existing"
  | "save-new"
  | "edit"
  | "direct"
  | "cancel";

/**
 * Rubric 确认面的 framing 纪律（对齐架构文档的呈现裁决）：
 * - 对齐语气而非流程语气：「我打算按这几条判断任务算不算完成」，不把
 *   Rubric 概念顶到用户脸上；顺带告知之后还能改（契约再生已支持），
 *   降低首次确认的心理重量。
 * - 折叠层级对齐公开 / 私有边界：确认面主体 = 通过标准 + 证据要求
 *   （「什么算做完」的公开面）；failureHandling 收进详情深层并标注为
 *   未达标时的续推安排——它是用户确认的契约但不是决策主体。
 * - matched / generated 差异化确认重量：命中库里已有准则用轻确认一行，
 *   现场生成才用通读式——source 区分缓解长期确认疲劳。
 */
export function createAdvancementContractSelectionRequest(
  draft: RubricContractDraftSnapshot,
): SelectionRequest<AdvancementContractSelectionValue> {
  const nearby = primaryNearbyCandidate(draft);
  const shouldOfferNearbyGovernance =
    draft.source === "generated" && nearby !== undefined;
  return {
    id: `advancement:${draft.draftId}`,
    ...(draft.source === "matched"
      ? {
          title: `按「${draft.title}」推进？`,
          body: [
            "这次任务命中了你确认过的验收方式，按它判断任务算不算完成。",
            "细节可展开查看；确认后如果要改，随时可以说。",
          ],
        }
      : shouldOfferNearbyGovernance
        ? {
            title: "确认怎么算做完",
            body: [
              "我打算按下面这几条判断这个任务算不算完成，你看对吗？",
              ...draft.content.passCriteria.map(
                (text, index) => `  ${index + 1}. ${text}`,
              ),
              `这和已有的「${nearby.title}」很接近，建议更新已有准则，避免准则库堆出一次性条目。`,
              "也可以另存为新的准则。",
            ],
          }
        : {
          title: "确认怎么算做完",
          body: [
            "我打算按下面这几条判断这个任务算不算完成，你看对吗？",
            ...draft.content.passCriteria.map(
              (text, index) => `  ${index + 1}. ${text}`,
            ),
            "确认后如果要改，随时可以说。",
          ],
        }),
    details: {
      title: "验收方式详情",
      body: renderRubricDraftDetails(draft),
    },
    options: [
      ...(shouldOfferNearbyGovernance
        ? [
            {
              value: "update-existing" as const,
              label: "更新已有并开始",
              description: `修订「${nearby.title}」并按新版推进`,
              hotkey: "y",
              tone: "primary" as const,
            },
            {
              value: "save-new" as const,
              label: "另存新准则",
              description: "明确作为新的场景准则沉淀",
              hotkey: "s",
            },
          ]
        : [
            {
              value: "confirm" as const,
              label: "确认并开始",
              description: "按这份推进准则执行任务",
              hotkey: "y",
              tone: "primary" as const,
            },
          ]),
      {
        value: "edit",
        label: "修改准则",
        description: "说明你想调整的验收标准，知行会重新生成草案",
        hotkey: "e",
        input: {
          placeholder: "例如：把文档更新也加入通过标准",
        },
      },
      {
        value: "direct",
        label: "直接执行",
        description: "不启用推进闭环，只按普通任务执行一次",
        hotkey: "d",
      },
      {
        value: "cancel",
        label: "取消任务",
        description: "不执行原任务，并关闭这次推进确认",
        hotkey: "c",
        tone: "danger",
        confirm: {
          title: "取消这次任务？",
          body: ["取消后不会执行原任务。"],
          confirmLabel: "确认取消",
          cancelLabel: "返回",
        },
      },
    ],
    initialValue: shouldOfferNearbyGovernance ? "update-existing" : "confirm",
    submitLabel: "选择",
    cancelLabel: "取消任务",
  };
}

export function primaryNearbyCandidate(
  draft: RubricContractDraftSnapshot,
): NonNullable<RubricContractDraftSnapshot["candidateRubrics"]>[number] | undefined {
  const id = draft.candidateRubricIds[0];
  if (!id) return undefined;
  const candidate = draft.candidateRubrics?.find((item) => item.id === id);
  if (
    !candidate ||
    typeof candidate.matchScore !== "number" ||
    candidate.matchScore < RUBRIC_NEARBY_SCORE_THRESHOLD
  ) {
    return undefined;
  }
  return candidate;
}

function renderRubricDraftDetails(
  draft: RubricContractDraftSnapshot,
): readonly string[] {
  const lines: string[] = [];
  appendSection(lines, "什么算做完（通过标准）", draft.content.passCriteria);

  const evidence = draft.content.evidenceRequirements?.map((item) => {
    const required = item.required === true ? "必需" : "可选";
    const located = item.locator?.paths?.length
      ? `，核验路径：${item.locator.paths.join("、")}`
      : "";
    return `${item.description}（${required}${located}）`;
  });
  appendSection(lines, "怎么核验（证据要求）", evidence ?? []);

  // 未达标时的续推安排——用户确认的契约内容，但不是确认决策的主体，
  // 收在详情最深处并说明用途（自动发给知行的催办内容）。
  const failureHandling = draft.content.failureHandling.map(
    (item) => `${item.scenario}：${item.reply}`,
  );
  appendSection(
    lines,
    "未达标时的续推安排（自动发给知行的催办内容）",
    failureHandling,
  );

  return lines;
}

function appendSection(
  lines: string[],
  title: string,
  items: readonly string[],
): void {
  if (lines.length > 0) lines.push("");
  lines.push(`${title}:`);
  if (items.length === 0) {
    lines.push("  - 未指定");
    return;
  }
  items.forEach((item, index) => {
    lines.push(`  ${index + 1}. ${item}`);
  });
}
