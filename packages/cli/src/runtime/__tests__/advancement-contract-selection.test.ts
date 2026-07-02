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

    // 对齐语气：不把 Rubric 概念顶到用户脸上；通过标准直接上确认面主体
    expect(request.title).toBe("确认怎么算做完");
    expect(request.body?.join("\n")).toContain("算不算完成");
    expect(request.body?.join("\n")).toContain("测试通过");
    expect(request.body?.join("\n")).toContain("确认后如果要改，随时可以说");
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
    // failureHandling 收在详情深层并标注用途——不是确认决策主体
    expect(request.details?.body.join("\n")).toContain("未达标时的续推安排");
    expect(request.details?.body.join("\n")).toContain("请修复失败测试后继续。");
    expect(request.body?.join("\n")).not.toContain("请修复失败测试后继续。");
  });

  it("matched 草案用轻确认：一行式标题，细节可展开", () => {
    const request = createAdvancementContractSelectionRequest({
      draftId: "draft-2",
      originalTurnId: "turn-2",
      source: "matched",
      candidateRubricIds: ["rubric-known"],
      title: "开发结果审查",
      description: "检查开发任务是否满足需求。",
      content: {
        passCriteria: ["测试通过"],
        evidenceRequirements: [],
        failureHandling: [
          { id: "fix", scenario: "测试未通过", reply: "请修复。" },
        ],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(request.title).toBe("按「开发结果审查」推进？");
    expect(request.body?.join("\n")).toContain("命中了你确认过的验收方式");
    expect(request.details?.body.join("\n")).toContain("测试通过");
  });
});
