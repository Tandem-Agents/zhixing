import type {
  AdvancementRunReview,
  AdvancementExitReason,
  AdvancementReviewDecision,
  ConfirmedRubricSnapshot,
  ReviewAttribution,
  ReviewCriterionAttribution,
  ReviewCriterionVerdict,
  ReviewEvidence,
} from "@zhixing/core/advancement";
import { deriveUnmetCriteriaTexts } from "@zhixing/core/advancement";
import type {
  JsonSchema,
  RunRecordRef,
  ToolDefinition,
  ToolResult,
} from "@zhixing/core";
import { requiresIndependentEvidence } from "./evidence.js";

export const ADVANCEMENT_SUBMIT_REVIEW_TOOL =
  "advancement_submit_review";

const REVIEW_DECISIONS = new Set<AdvancementReviewDecision>([
  "passed",
  "failed",
  "exit",
]);

const EXIT_REASONS = new Set<AdvancementExitReason>([
  "dead-end",
  "user-cancelled",
  "user-took-over",
  "superseded",
  "system-error",
  "capability-gap",
]);

export interface CreateAdvancementJudgeToolInput {
  readonly rubric: ConfirmedRubricSnapshot;
  readonly runIndex: number;
  readonly runRecordRef?: RunRecordRef;
  readonly availableEvidence: readonly ReviewEvidence[];
  readonly now: () => Date;
  readonly idGenerator: () => string;
}

export interface AdvancementJudgeToolController {
  readonly tool: ToolDefinition;
  getSubmittedReview(): AdvancementRunReview | null;
}

export function createAdvancementJudgeTool(
  input: CreateAdvancementJudgeToolInput,
): AdvancementJudgeToolController {
  let submittedReview: AdvancementRunReview | null = null;

  const tool: ToolDefinition = {
    name: ADVANCEMENT_SUBMIT_REVIEW_TOOL,
    description:
      "提交推进侧对本轮执行结果的验收结论。必须对每条通过标准给出逐条判定；证据以 id 引用已收集列表（证据事实由取证层持有，不接受改写），不得编造。",
    inputSchema: buildReviewInputSchema(input.rubric),
    isReadOnly: true,
    isParallelSafe: false,
    needsPermission: false,
    async call(rawInput): Promise<ToolResult> {
      if (submittedReview) {
        return {
          content: "本轮裁判结论已经提交，不能重复提交。",
          isError: true,
        };
      }

      const result = buildSubmittedReview(rawInput, input);
      if (!result.ok) {
        return { content: result.error, isError: true };
      }

      submittedReview = result.review;
      return {
        content: JSON.stringify({
          accepted: true,
          reviewId: result.review.id,
          decision: result.review.decision,
        }),
      };
    },
  };

  return {
    tool,
    getSubmittedReview: () => submittedReview,
  };
}

function buildReviewInputSchema(rubric: ConfirmedRubricSnapshot): JsonSchema {
  const criterionIds = rubric.content.passCriteria.map((item) => item.id);
  return {
    type: "object",
    additionalProperties: false,
    required: ["decision", "criteria", "evidenceIds"],
    properties: {
      decision: {
        type: "string",
        enum: ["passed", "failed", "exit"],
        description: "本轮验收结论。",
      },
      criteria: {
        type: "array",
        description:
          "对每条通过标准的逐条判定，必须恰好覆盖全部 criterionId 各一次。未满足项由此派生，不再单独提交。",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["criterionId", "verdict", "reason"],
          properties: {
            criterionId: {
              type: "string",
              enum: criterionIds,
              description: "已确认 Rubric 中通过标准的条目 id。",
            },
            verdict: {
              type: "string",
              enum: ["met", "unmet", "unknown"],
              description:
                "met=已满足；unmet=未满足；unknown=无法独立核验、按执行侧报告采信。",
            },
            reason: {
              type: "string",
              description: "一句话结论性理由，不写思考过程。",
            },
            evidenceExcerpt: {
              type: "string",
              description: "支撑该判定的独立证据摘录；有独立取证时必填。",
            },
          },
        },
      },
      evidenceIds: {
        type: "array",
        description:
          "裁判采用的证据 id 列表，必须来自已提供的 evidence 列表。证据的事实内容（摘要 / 判定 / 来源）由取证层持有，按 id 原样采用——不提交、不改写。",
        items: { type: "string" },
      },
      selectedFailureHandlingId: {
        type: "string",
        description: "未通过时选用的 Rubric failureHandling id。",
      },
      exitReason: {
        type: "string",
        enum: [
          "dead-end",
          "user-cancelled",
          "user-took-over",
          "superseded",
          "system-error",
          "capability-gap",
        ],
        description:
          "退出推进闭环时的原因。required 客观证据超出系统独立核验能力、继续催证也无法解开时用 capability-gap（请用户人工验收），不得循环 failed。",
      },
    },
  };
}

function buildSubmittedReview(
  rawInput: Record<string, unknown>,
  context: CreateAdvancementJudgeToolInput,
):
  | {
      readonly ok: true;
      readonly review: AdvancementRunReview;
    }
  | { readonly ok: false; readonly error: string } {
  const decision = rawInput.decision;
  if (typeof decision !== "string" || !REVIEW_DECISIONS.has(decision as never)) {
    return { ok: false, error: "decision 必须是 passed / failed / exit。" };
  }

  const attributionResult = normalizeSubmittedCriteria(
    rawInput.criteria,
    context.rubric,
  );
  if (!attributionResult.ok) return attributionResult;

  const evidenceResult = normalizeSubmittedEvidence(
    rawInput.evidenceIds,
    context.availableEvidence,
    new Set(
      (context.rubric.content.evidenceRequirements ?? []).map(
        (requirement) => requirement.id,
      ),
    ),
  );
  if (!evidenceResult.ok) return evidenceResult;

  const selectedFailureHandlingId = optionalString(
    rawInput.selectedFailureHandlingId,
    "selectedFailureHandlingId",
  );
  if (!selectedFailureHandlingId.ok) return selectedFailureHandlingId;
  const exitReason = optionalExitReason(rawInput.exitReason);
  if (!exitReason.ok) return exitReason;

  const attribution = attributionResult.attribution;
  const unmetCriteria = deriveUnmetCriteriaTexts(
    attribution,
    context.rubric.content.passCriteria,
  );

  const policyError = validateDecisionPolicy({
    decision: decision as AdvancementReviewDecision,
    selectedFailureHandlingId: selectedFailureHandlingId.value,
    exitReason: exitReason.value,
    attribution,
    evidence: evidenceResult.evidence,
    rubric: context.rubric,
  });
  if (policyError) return { ok: false, error: policyError };

  return {
    ok: true,
    review: {
      id: context.idGenerator(),
      runIndex: context.runIndex,
      runRecordRef: context.runRecordRef,
      reviewedAt: context.now().toISOString(),
      decision: decision as AdvancementReviewDecision,
      evidence: evidenceResult.evidence,
      attribution,
      unmetCriteria,
      selectedFailureHandlingId: selectedFailureHandlingId.value,
      exitReason: exitReason.value,
    },
  };
}

const CRITERION_VERDICTS = new Set<ReviewCriterionVerdict>([
  "met",
  "unmet",
  "unknown",
]);

function normalizeSubmittedCriteria(
  value: unknown,
  rubric: ConfirmedRubricSnapshot,
):
  | { readonly ok: true; readonly attribution: ReviewAttribution }
  | { readonly ok: false; readonly error: string } {
  if (!Array.isArray(value)) {
    return { ok: false, error: "criteria 必须是数组。" };
  }
  const knownIds = new Set(rubric.content.passCriteria.map((item) => item.id));
  const seen = new Set<string>();
  const criteria: ReviewCriterionAttribution[] = [];

  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: `criteria[${index}] 必须是对象。` };
    }
    const record = raw as Record<string, unknown>;
    const criterionId = record.criterionId;
    if (typeof criterionId !== "string" || !knownIds.has(criterionId)) {
      return {
        ok: false,
        error: `criteria[${index}].criterionId 不属于已确认 Rubric 的条目集。`,
      };
    }
    if (seen.has(criterionId)) {
      return { ok: false, error: `criterion "${criterionId}" 被重复判定。` };
    }
    seen.add(criterionId);

    const verdict = record.verdict;
    if (
      typeof verdict !== "string" ||
      !CRITERION_VERDICTS.has(verdict as never)
    ) {
      return {
        ok: false,
        error: `criterion "${criterionId}" 的 verdict 必须是 met / unmet / unknown。`,
      };
    }
    const reason = record.reason;
    if (typeof reason !== "string" || !reason.trim()) {
      return {
        ok: false,
        error: `criterion "${criterionId}" 缺少结论性理由。`,
      };
    }
    const excerpt = optionalString(
      record.evidenceExcerpt,
      `criterion "${criterionId}".evidenceExcerpt`,
    );
    if (!excerpt.ok) return excerpt;

    criteria.push({
      criterionId,
      verdict: verdict as ReviewCriterionVerdict,
      reason: reason.trim(),
      ...(excerpt.value ? { evidenceExcerpt: excerpt.value } : {}),
    });
  }

  if (seen.size !== knownIds.size) {
    return {
      ok: false,
      error: "criteria 必须恰好覆盖已确认 Rubric 的全部通过标准条目。",
    };
  }
  return { ok: true, attribution: { criteria } };
}

/**
 * 证据采用是 id 引用，不是内容提交：持久化的 evidence 恒为取证层的
 * canonical 对象——摘要、判定、来源、绑定全部由取证层持有，模型没有任何
 * 字段可以改写（逐字段"复述 + 校验一致"的形态里每个字段都是潜在的校验
 * 遗漏面）。模型对证据的解读走归因层（criteria 的 reason / evidenceExcerpt）。
 */
function normalizeSubmittedEvidence(
  value: unknown,
  availableEvidence: readonly ReviewEvidence[],
  knownRequirementIds: ReadonlySet<string>,
):
  | { readonly ok: true; readonly evidence: readonly ReviewEvidence[] }
  | { readonly ok: false; readonly error: string } {
  if (!Array.isArray(value)) {
    return { ok: false, error: "evidenceIds 必须是字符串数组。" };
  }

  const availableById = new Map(availableEvidence.map((item) => [item.id, item]));
  const out: ReviewEvidence[] = [];
  const seen = new Set<string>();

  for (const [index, raw] of value.entries()) {
    if (typeof raw !== "string" || !raw.trim()) {
      return { ok: false, error: `evidenceIds[${index}] 必须是非空字符串。` };
    }
    const id = raw.trim();
    if (seen.has(id)) {
      return { ok: false, error: `evidence "${id}" 被重复引用。` };
    }
    seen.add(id);

    const canonical = availableById.get(id);
    if (!canonical) {
      return { ok: false, error: `evidence "${id}" 不在已收集证据列表中。` };
    }
    if (
      canonical.requirementId &&
      !knownRequirementIds.has(canonical.requirementId)
    ) {
      return {
        ok: false,
        error: `evidence "${id}" 绑定了未知的 requirementId。`,
      };
    }
    out.push(canonical);
  }

  return { ok: true, evidence: out };
}

function validateDecisionPolicy(input: {
  readonly decision: AdvancementReviewDecision;
  readonly selectedFailureHandlingId?: string;
  readonly exitReason?: AdvancementExitReason;
  readonly attribution: ReviewAttribution;
  readonly evidence: readonly ReviewEvidence[];
  readonly rubric: ConfirmedRubricSnapshot;
}): string | null {
  const failureHandlingIds = new Set(
    input.rubric.content.failureHandling.map((item) => item.id),
  );
  const unmetCount = input.attribution.criteria.filter(
    (item) => item.verdict === "unmet",
  ).length;

  if (input.decision === "passed") {
    if (unmetCount > 0) {
      return "passed 结论下不得存在 unmet 判定。";
    }
    if (input.selectedFailureHandlingId) {
      return "passed 结论不能选择 failureHandling。";
    }
    if (input.exitReason) {
      return "passed 结论不能携带 exitReason。";
    }
    return validateRequiredObjectiveEvidence(input.rubric, input.evidence);
  }

  if (input.decision === "failed") {
    if (!input.selectedFailureHandlingId) {
      return "failed 结论必须选择 selectedFailureHandlingId。";
    }
    if (!failureHandlingIds.has(input.selectedFailureHandlingId)) {
      return `selectedFailureHandlingId "${input.selectedFailureHandlingId}" 不存在。`;
    }
    if (unmetCount === 0) {
      return "failed 结论必须至少有一条 unmet 判定。";
    }
    if (input.exitReason) {
      return "failed 结论不能携带 exitReason。";
    }
    return null;
  }

  if (!input.exitReason) {
    return "exit 结论必须携带 exitReason。";
  }
  if (input.selectedFailureHandlingId) {
    return "exit 结论不能选择 failureHandling。";
  }
  return null;
}

function validateRequiredObjectiveEvidence(
  rubric: ConfirmedRubricSnapshot,
  evidence: readonly ReviewEvidence[],
): string | null {
  const byRequirement = new Map<string, ReviewEvidence[]>();
  for (const item of evidence) {
    if (!item.requirementId) continue;
    const list = byRequirement.get(item.requirementId) ?? [];
    list.push(item);
    byRequirement.set(item.requirementId, list);
  }

  for (const requirement of rubric.content.evidenceRequirements ?? []) {
    if (requirement.required !== true) continue;
    if (!requiresIndependentEvidence(requirement.kind)) continue;

    const matches = byRequirement.get(requirement.id) ?? [];
    const satisfied = matches.some(
      (item) =>
        item.kind === requirement.kind &&
        item.source === "independent" &&
        item.passed === true,
    );
    if (!satisfied) {
      return `required evidence "${requirement.id}" 缺少已通过的独立证据。`;
    }
  }

  return null;
}

function optionalString(
  value: unknown,
  field: string,
):
  | { readonly ok: true; readonly value?: string }
  | { readonly ok: false; readonly error: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string") {
    return { ok: false, error: `${field} 必须是字符串。` };
  }
  const trimmed = value.trim();
  return trimmed ? { ok: true, value: trimmed } : { ok: true };
}

function optionalExitReason(
  value: unknown,
):
  | { readonly ok: true; readonly value?: AdvancementExitReason }
  | { readonly ok: false; readonly error: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string" || !EXIT_REASONS.has(value as never)) {
    return { ok: false, error: "exitReason 非法。" };
  }
  return { ok: true, value: value as AdvancementExitReason };
}
