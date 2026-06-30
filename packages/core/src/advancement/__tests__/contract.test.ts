import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import { RubricStore } from "../../rubrics/store.js";
import {
  LLMRubricDraftGenerationStrategy,
  RubricContractBuilder,
} from "../contract.js";
import { userTurnInputFromText } from "../../types/user-input.js";

describe("RubricContractBuilder", () => {
  it("命中已有 Rubric 时生成 matched 草案", async () => {
    const rubricStore = new RubricStore(
      path.join(await createTempDir("rubric-contract"), "rubrics"),
    );
    const saved = await rubricStore.saveOwn({
      title: "测试全绿推进准则",
      description: "用于测试全绿任务",
      content: {
        passCriteria: ["测试通过"],
        evidenceRequirements: ["测试结果需要通过"],
        failureHandling: [
          {
            scenario: "测试失败",
            reply: "请修复失败测试后继续。",
          },
        ],
      },
    });

    const builder = new RubricContractBuilder({
      rubricStore,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const draft = await builder.buildDraft({
      originalTurnId: "turn-1",
      originalUserTask: userTurnInputFromText("请把测试全绿任务盯到验收通过"),
    });

    expect(draft.source).toBe("matched");
    expect(draft.candidateRubricIds[0]).toBe(saved.id);
    expect(draft.content.passCriteria).toEqual(["测试通过"]);
    expect(draft.content.evidenceRequirements?.[0]?.kind).toBe("test-result");
  });

  it("未命中且没有生成策略时不伪造通用草案", async () => {
    const rubricStore = new RubricStore(
      path.join(await createTempDir("rubric-contract"), "rubrics"),
    );
    const builder = new RubricContractBuilder({
      rubricStore,
      now: () => "2026-01-01T00:00:00.000Z",
    });

    await expect(builder.buildDraft({
      originalTurnId: "turn-2",
      originalUserTask: userTurnInputFromText("请实现导出功能并跑测试"),
    })).rejects.toThrow("no draft generation strategy is configured");
  });

  it("未命中时可用 LLM 策略生成贴合场景的草案", async () => {
    const rubricStore = new RubricStore(
      path.join(await createTempDir("rubric-contract"), "rubrics"),
    );
    const prompts: string[] = [];
    const builder = new RubricContractBuilder({
      rubricStore,
      now: () => "2026-01-01T00:00:00.000Z",
      generationStrategy: new LLMRubricDraftGenerationStrategy({
        complete: async (prompt) => {
          prompts.push(prompt);
          return JSON.stringify({
            title: "导出功能验收准则",
            description: "用于判断导出功能是否完成并可验收。",
            passCriteria: ["导出入口可用", "导出文件内容符合用户指定格式"],
            evidenceRequirements: [
              {
                id: "file-diff",
                kind: "file-diff",
                description: "可以核对导出功能相关文件变更。",
                required: true,
              },
            ],
            failureHandling: [
              {
                id: "continue-export",
                scenario: "导出结果不满足格式要求",
                reply: "导出功能尚未达到验收标准。请继续修正格式问题，并说明验证结果。",
              },
            ],
          });
        },
      }),
    });

    const draft = await builder.buildDraft({
      originalTurnId: "turn-llm",
      originalUserTask: userTurnInputFromText("请把导出功能做到可验收"),
    });

    expect(prompts).toHaveLength(1);
    expect(draft.source).toBe("generated");
    expect(draft.title).toBe("导出功能验收准则");
    expect(draft.content.passCriteria).toContain("导出入口可用");
    expect(draft.content.failureHandling[0]?.reply).toContain("继续修正格式问题");
  });
});
