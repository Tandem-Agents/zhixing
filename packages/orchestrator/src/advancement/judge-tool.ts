import type {
  AdvancementRunReview,
  AdvancementExitReason,
  AdvancementReviewDecision,
  ConfirmedRubricSnapshot,
  ObjectiveSignalKind,
  ReviewEvidence,
} from "@zhixing/core/advancement";
import type {
  JsonSchema,
  RunRecordRef,
  ToolDefinition,
  ToolResult,
} from "@zhixing/core";
import { requiresIndependentEvidence } from "./evidence.js";

export const ADVANCEMENT_SUBMIT_REVIEW_TOOL =
  "advancement_submit_review";

const OBJECTIVE_SIGNAL_KINDS = new Set<ObjectiveSignalKind>([
  "file-diff",
  "test-result",
  "build-result",
  "log",
  "artifact",
  "conversation-fact",
  "none",
]);

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
      "提交推进侧对本轮执行结果的验收结论。必须只引用已提供的 evidence id，不得编造独立证据。",
    inputSchema: REVIEW_INPUT_SCHEMA,
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

const REVIEW_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "evidence", "unmetCriteria"],
  properties: {
    decision: {
      type: "string",
      enum: ["passed", "failed", "exit"],
      description: "本轮验收结论。",
    },
    evidence: {
      type: "array",
      description: "裁判采用的证据。每条 id 必须来自已提供的 evidence 列表。",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "summary"],
        properties: {
          id: { type: "string" },
          kind: {
            type: "string",
            enum: [
              "file-diff",
              "test-result",
              "build-result",
              "log",
              "artifact",
              "conversation-fact",
              "none",
            ],
          },
          summary: { type: "string" },
          requirementId: { type: "string" },
          source: {
            type: "string",
            enum: ["independent", "execution-report", "user"],
          },
          passed: { type: "boolean" },
          refs: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    },
    unmetCriteria: {
      type: "array",
      items: { type: "string" },
      description: "未满足的通过标准。通过时必须为空。",
    },
    selectedFailureHandlingId: {
      type: "string",
      description: "未通过时选用的 Rubric failureHandling id。",
    },
    exitReason: {
      type: "string",
      enum: ["dead-end", "user-cancelled", "user-took-over", "superseded", "system-error"],
      description: "退出推进闭环时的原因。",
    },
  },
};

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

  const evidenceResult = normalizeSubmittedEvidence(
    rawInput.evidence,
    context.availableEvidence,
    new Set(
      (context.rubric.content.evidenceRequirements ?? []).map(
        (requirement) => requirement.id,
      ),
    ),
  );
  if (!evidenceResult.ok) return evidenceResult;

  const unmetCriteria = normalizeStringArray(rawInput.unmetCriteria, "unmetCriteria");
  if (!unmetCriteria.ok) return unmetCriteria;

  const selectedFailureHandlingId = optionalString(
    rawInput.selectedFailureHandlingId,
    "selectedFailureHandlingId",
  );
  if (!selectedFailureHandlingId.ok) return selectedFailureHandlingId;
  const exitReason = optionalExitReason(rawInput.exitReason);
  if (!exitReason.ok) return exitReason;

  const policyError = validateDecisionPolicy({
    decision: decision as AdvancementReviewDecision,
    selectedFailureHandlingId: selectedFailureHandlingId.value,
    exitReason: exitReason.value,
    unmetCriteria: unmetCriteria.values,
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
      unmetCriteria: unmetCriteria.values,
      selectedFailureHandlingId: selectedFailureHandlingId.value,
      exitReason: exitReason.value,
    },
  };
}

function normalizeSubmittedEvidence(
  value: unknown,
  availableEvidence: readonly ReviewEvidence[],
  knownRequirementIds: ReadonlySet<string>,
):
  | { readonly ok: true; readonly evidence: readonly ReviewEvidence[] }
  | { readonly ok: false; readonly error: string } {
  if (!Array.isArray(value)) {
    return { ok: false, error: "evidence 必须是数组。" };
  }

  const availableById = new Map(availableEvidence.map((item) => [item.id, item]));
  const out: ReviewEvidence[] = [];
  const seen = new Set<string>();

  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: `evidence[${index}] 必须是对象。` };
    }
    const record = raw as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== "string" || !id.trim()) {
      return { ok: false, error: `evidence[${index}].id 必须是非空字符串。` };
    }
    if (seen.has(id)) {
      return { ok: false, error: `evidence "${id}" 被重复引用。` };
    }
    seen.add(id);

    const canonical = availableById.get(id);
    if (!canonical) {
      return { ok: false, error: `evidence "${id}" 不在已收集证据列表中。` };
    }

    const kind = record.kind;
    if (typeof kind !== "string" || !OBJECTIVE_SIGNAL_KINDS.has(kind as never)) {
      return { ok: false, error: `evidence "${id}" 的 kind 非法。` };
    }
    if (kind !== canonical.kind) {
      return { ok: false, error: `evidence "${id}" 的 kind 与已收集证据不一致。` };
    }

    const source = optionalSource(record.source);
    if (!source.ok) return source;
    if (source.value && source.value !== canonical.source) {
      return { ok: false, error: `evidence "${id}" 的 source 与已收集证据不一致。` };
    }

    const requirementId = optionalString(record.requirementId, `evidence "${id}".requirementId`);
    if (!requirementId.ok) return requirementId;
    if (requirementId.value && requirementId.value !== canonical.requirementId) {
      return {
        ok: false,
        error: `evidence "${id}" 的 requirementId 与已收集证据不一致。`,
      };
    }
    const finalRequirementId = canonical.requirementId;
    if (finalRequirementId && !knownRequirementIds.has(finalRequirementId)) {
      return {
        ok: false,
        error: `evidence "${id}" 绑定了未知的 requirementId。`,
      };
    }

    const refs = normalizeOptionalStringArray(record.refs, `evidence "${id}".refs`);
    if (!refs.ok) return refs;
    if (refs.values && !sameStringArray(refs.values, canonical.refs)) {
      return { ok: false, error: `evidence "${id}" 的 refs 与已收集证据不一致。` };
    }

    const summary = record.summary;
    if (typeof summary !== "string" || !summary.trim()) {
      return { ok: false, error: `evidence "${id}" 缺少 summary。` };
    }

    const passed = optionalBoolean(record.passed, `evidence "${id}".passed`);
    if (!passed.ok) return passed;
    if (
      canonical.passed !== undefined &&
      passed.value !== undefined &&
      passed.value !== canonical.passed
    ) {
      return { ok: false, error: `evidence "${id}" 的 passed 与已收集证据不一致。` };
    }
    out.push({
      ...canonical,
      summary: summary.trim(),
      requirementId: finalRequirementId,
      source: canonical.source,
      passed: canonical.passed ?? passed.value,
      refs: refs.values ?? canonical.refs,
    });
  }

  return { ok: true, evidence: out };
}

function validateDecisionPolicy(input: {
  readonly decision: AdvancementReviewDecision;
  readonly selectedFailureHandlingId?: string;
  readonly exitReason?: AdvancementExitReason;
  readonly unmetCriteria: readonly string[];
  readonly evidence: readonly ReviewEvidence[];
  readonly rubric: ConfirmedRubricSnapshot;
}): string | null {
  const failureHandlingIds = new Set(
    input.rubric.content.failureHandling.map((item) => item.id),
  );

  if (input.decision === "passed") {
    if (input.unmetCriteria.length > 0) {
      return "passed 结论下 unmetCriteria 必须为空。";
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
    if (input.unmetCriteria.length === 0) {
      return "failed 结论必须说明 unmetCriteria。";
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

function normalizeStringArray(
  value: unknown,
  field: string,
):
  | { readonly ok: true; readonly values: readonly string[] }
  | { readonly ok: false; readonly error: string } {
  if (!Array.isArray(value)) {
    return { ok: false, error: `${field} 必须是字符串数组。` };
  }
  const values: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") {
      return { ok: false, error: `${field}[${index}] 必须是字符串。` };
    }
    const trimmed = item.trim();
    if (trimmed) values.push(trimmed);
  }
  return { ok: true, values };
}

function normalizeOptionalStringArray(
  value: unknown,
  field: string,
):
  | { readonly ok: true; readonly values?: readonly string[] }
  | { readonly ok: false; readonly error: string } {
  if (value === undefined) return { ok: true };
  const normalized = normalizeStringArray(value, field);
  if (!normalized.ok) return normalized;
  return { ok: true, values: normalized.values };
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

function optionalBoolean(
  value: unknown,
  field: string,
):
  | { readonly ok: true; readonly value?: boolean }
  | { readonly ok: false; readonly error: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "boolean") {
    return { ok: false, error: `${field} 必须是 boolean。` };
  }
  return { ok: true, value };
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

function optionalSource(
  value: unknown,
):
  | { readonly ok: true; readonly value?: ReviewEvidence["source"] }
  | { readonly ok: false; readonly error: string } {
  if (value === undefined) return { ok: true };
  if (
    value !== "independent" &&
    value !== "execution-report" &&
    value !== "user"
  ) {
    return { ok: false, error: "evidence.source 非法。" };
  }
  return { ok: true, value };
}

function sameStringArray(
  a: readonly string[],
  b: readonly string[] | undefined,
): boolean {
  if (!b || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}
