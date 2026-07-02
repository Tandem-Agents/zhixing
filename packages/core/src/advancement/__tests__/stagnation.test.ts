import { describe, expect, it } from "vitest";
import { detectStagnation } from "../stagnation.js";
import type { AdvancementRunReview, ReviewEvidence } from "../types.js";

function failedReview(input: {
  readonly id: string;
  readonly runIndex: number;
  readonly unmet: readonly string[];
  readonly evidence?: readonly ReviewEvidence[];
}): AdvancementRunReview {
  return {
    id: input.id,
    runIndex: input.runIndex,
    reviewedAt: "2026-01-01T00:02:00.000Z",
    decision: "failed",
    evidence: input.evidence ?? [],
    attribution: {
      criteria: [
        { criterionId: "pc-1", verdict: "met", reason: "已实现。" },
        ...input.unmet.map((criterionId) => ({
          criterionId,
          verdict: "unmet" as const,
          reason: "未满足。",
        })),
      ],
    },
    unmetCriteria: input.unmet,
    selectedFailureHandlingId: "continue",
  };
}

function passedReview(runIndex: number): AdvancementRunReview {
  return {
    id: `review-pass-${runIndex}`,
    runIndex,
    reviewedAt: "2026-01-01T00:02:00.000Z",
    decision: "passed",
    evidence: [],
    attribution: {
      criteria: [{ criterionId: "pc-1", verdict: "met", reason: "完成。" }],
    },
    unmetCriteria: [],
  };
}

const testEvidence = (summary: string): ReviewEvidence => ({
  id: "tests",
  kind: "test-result",
  summary,
  source: "independent",
  passed: false,
});

describe("detectStagnation", () => {
  it("尾部连续多轮 failed 的 unmet 集与证据指纹无变化时报僵持信号", () => {
    const signal = detectStagnation([
      failedReview({ id: "r0", runIndex: 0, unmet: ["pc-2"], evidence: [testEvidence("1 failed")] }),
      failedReview({ id: "r1", runIndex: 1, unmet: ["pc-2"], evidence: [testEvidence("1 failed")] }),
      failedReview({ id: "r2", runIndex: 2, unmet: ["pc-2"], evidence: [testEvidence("1 failed")] }),
    ]);
    expect(signal).toEqual({
      stagnantRounds: 3,
      unmetCriterionIds: ["pc-2"],
    });
  });

  it("证据指纹变化说明有新进展，不报僵持", () => {
    const signal = detectStagnation([
      failedReview({ id: "r0", runIndex: 0, unmet: ["pc-2"], evidence: [testEvidence("3 failed")] }),
      failedReview({ id: "r1", runIndex: 1, unmet: ["pc-2"], evidence: [testEvidence("1 failed")] }),
    ]);
    expect(signal).toBeUndefined();
  });

  it("unmet 条目集变化说明缺口在移动，不报僵持", () => {
    const signal = detectStagnation([
      failedReview({ id: "r0", runIndex: 0, unmet: ["pc-2", "pc-3"] }),
      failedReview({ id: "r1", runIndex: 1, unmet: ["pc-2"] }),
    ]);
    expect(signal).toBeUndefined();
  });

  it("单轮 failed 是正常推进，不报僵持", () => {
    expect(
      detectStagnation([failedReview({ id: "r0", runIndex: 0, unmet: ["pc-2"] })]),
    ).toBeUndefined();
  });

  it("尾段被非 failed 轮截断后只按尾段判断", () => {
    const signal = detectStagnation([
      failedReview({ id: "r0", runIndex: 0, unmet: ["pc-2"] }),
      failedReview({ id: "r1", runIndex: 1, unmet: ["pc-2"] }),
      passedReview(2),
    ]);
    expect(signal).toBeUndefined();
  });

  it("空序列不报僵持", () => {
    expect(detectStagnation([])).toBeUndefined();
  });
});
