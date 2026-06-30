import { describe, expect, it } from "vitest";
import { createAdvancementContractSelectionRequest } from "../advancement-contract-selection.js";

describe("advancement contract selection adapter", () => {
  it("把 Rubric 草案映射为通用 SelectionRequest", () => {
    const request = createAdvancementContractSelectionRequest({
      draftId: "draft-1",
      originalTurnId: "turn-1",
      source: "generated",
      candidateRubricIds: [],
      title: "开发结果审查",
      description: "检查开发任务是否满足需求。",
      content: {
        passCriteria: ["测试通过", "需求点已覆盖"],
        evidenceRequirements: [
          {
            id: "tests",
            kind: "test-result",
            description: "测试结果",
            required: true,
          },
        ],
        failureHandling: [
          {
            id: "fix",
            scenario: "测试未通过",
            reply: "请修复失败测试后继续。",
          },
        ],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(request.title).toBe("确认推进准则");
    expect(request.options.map((option) => option.value)).toEqual([
      "confirm",
      "edit",
      "direct",
      "cancel",
    ]);
    expect(request.options.find((option) => option.value === "edit")).toEqual(
      expect.objectContaining({
        input: expect.objectContaining({ placeholder: expect.any(String) }),
      }),
    );
    expect(request.details?.body.join("\n")).toContain("测试通过");
    expect(request.details?.body.join("\n")).toContain("请修复失败测试后继续。");
  });
});
