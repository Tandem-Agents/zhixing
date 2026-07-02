import { describe, expect, it } from "vitest";
import {
  deriveUnmetCriteriaTexts,
  renderAcceptanceConditions,
  renderReviewAttribution,
} from "../attribution.js";
import type { PassCriterionSnapshot, ReviewAttribution } from "../types.js";

const CRITERIA: readonly PassCriterionSnapshot[] = [
  { id: "pc-1", text: "测试通过" },
  { id: "pc-2", text: "实现满足需求" },
  { id: "pc-3", text: "文档已更新" },
];

function attribution(): ReviewAttribution {
  return {
    criteria: [
      {
        criterionId: "pc-1",
        verdict: "unmet",
        reason: "仍有 1 个测试失败。",
        evidenceExcerpt: "vitest: 1 failed",
      },
      { criterionId: "pc-2", verdict: "met", reason: "实现已覆盖需求点。" },
      {
        criterionId: "pc-3",
        verdict: "unknown",
        reason: "没有可独立核验的文档变更证据。",
      },
    ],
  };
}

describe("renderReviewAttribution", () => {
  it("按快照条目顺序渲染逐条判定与证据摘录", () => {
    const text = renderReviewAttribution(attribution(), CRITERIA);

    expect(text).toContain("【验收判定】");
    expect(text).toContain("- 测试通过：未满足。仍有 1 个测试失败。");
    expect(text).toContain("  证据：vitest: 1 failed");
    expect(text).toContain("- 实现满足需求：已满足。实现已覆盖需求点。");
    expect(text).toContain(
      "- 文档已更新：无法独立核验，按执行侧报告采信。没有可独立核验的文档变更证据。",
    );
    const lines = text.split("\n");
    expect(lines.indexOf(lines.find((l) => l.includes("测试通过"))!)).toBeLessThan(
      lines.indexOf(lines.find((l) => l.includes("文档已更新"))!),
    );
  });

  it("对同一归因重复渲染产出完全一致的文本", () => {
    expect(renderReviewAttribution(attribution(), CRITERIA)).toBe(
      renderReviewAttribution(attribution(), CRITERIA),
    );
  });

  it("系统兜底 review 的空 criteria 渲染为空串", () => {
    expect(renderReviewAttribution({ criteria: [] }, CRITERIA)).toBe("");
  });
});

describe("deriveUnmetCriteriaTexts", () => {
  it("只投影 unmet 条目的标准文本", () => {
    expect(deriveUnmetCriteriaTexts(attribution(), CRITERIA)).toEqual([
      "测试通过",
    ]);
  });

  it("空 criteria 派生空投影", () => {
    expect(deriveUnmetCriteriaTexts({ criteria: [] }, CRITERIA)).toEqual([]);
  });
});

describe("renderAcceptanceConditions", () => {
  it("渲染通过标准与证据要求（含必需性与核验路径），不含 failureHandling", () => {
    const text = renderAcceptanceConditions({
      passCriteria: CRITERIA,
      evidenceRequirements: [
        {
          id: "tests",
          kind: "test-result",
          description: "相关测试必须通过",
          required: true,
        },
        {
          id: "log",
          kind: "log",
          description: "导出日志可核对",
          required: false,
          locator: { paths: ["logs/export.log"] },
        },
      ],
      failureHandling: [
        { id: "fix", scenario: "测试失败", reply: "请修复失败测试。" },
      ],
    });

    expect(text).toContain("验收条件");
    expect(text).toContain("- 测试通过");
    expect(text).toContain("- 实现满足需求");
    expect(text).toContain("验收时将核对以下证据：");
    expect(text).toContain("- 相关测试必须通过（必需）");
    expect(text).toContain(
      "- 导出日志可核对（可选，核验路径：logs/export.log）",
    );
    expect(text).not.toContain("请修复失败测试。");
  });

  it("无证据要求时只渲染通过标准", () => {
    const text = renderAcceptanceConditions({
      passCriteria: CRITERIA,
      failureHandling: [],
    });
    expect(text).not.toContain("核对以下证据");
  });
});
