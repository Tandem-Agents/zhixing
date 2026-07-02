import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import { RubricStore } from "../../rubrics/store.js";
import {
  LLMRubricDraftGenerationStrategy,
  LLMRubricDraftRevisionStrategy,
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
    // 生成契约是场景级的：标准供同类任务复用，任务细节归证据要求承载
    expect(prompts[0]).toContain("场景可复用");
    expect(prompts[0]).not.toContain("必须贴合当前任务");
  });

  it("可用 LLM 修订策略按用户反馈生成新版草案", async () => {
    const rubricStore = new RubricStore(
      path.join(await createTempDir("rubric-contract-revise"), "rubrics"),
    );
    const builder = new RubricContractBuilder({
      rubricStore,
      now: () => "2026-01-01T00:10:00.000Z",
      revisionStrategy: new LLMRubricDraftRevisionStrategy({
        complete: async (prompt) => {
          expect(prompt).toContain("请补充文档验收");
          expect(prompt).toContain("导出功能验收准则");
          return JSON.stringify({
            title: "导出功能与文档验收准则",
            description: "用于判断导出功能和说明文档是否完成。",
            passCriteria: ["导出入口可用", "文档说明已更新"],
            evidenceRequirements: [
              {
                id: "diff",
                kind: "file-diff",
                description: "核对导出代码和文档变更。",
                required: true,
              },
            ],
            failureHandling: [
              {
                id: "continue",
                scenario: "导出或文档未达标",
                reply: "请继续补齐导出功能和文档说明，并给出验证结果。",
              },
            ],
          });
        },
      }),
    });

    const revised = await builder.reviseDraft({
      currentDraft: {
        draftId: "draft-old",
        originalTurnId: "turn-1",
        source: "generated",
        candidateRubricIds: ["rubric-nearby"],
        title: "导出功能验收准则",
        description: "用于判断导出功能是否完成。",
        content: {
          passCriteria: ["导出入口可用"],
          evidenceRequirements: [
            {
              id: "diff",
              kind: "file-diff",
              description: "核对导出代码变更。",
              required: true,
            },
          ],
          failureHandling: [
            {
              id: "continue",
              scenario: "导出未达标",
              reply: "请继续修正导出功能。",
            },
          ],
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      originalUserTask: userTurnInputFromText("请把导出功能做到可验收"),
      userFeedback: "请补充文档验收",
    });

    expect(revised.draftId).not.toBe("draft-old");
    expect(revised.originalTurnId).toBe("turn-1");
    expect(revised.source).toBe("generated");
    expect(revised.candidateRubricIds).toEqual(["rubric-nearby"]);
    expect(revised.content.passCriteria).toContain("文档说明已更新");
  });

  it("required 只能落在取证能力集内的 kind 上，log 无定位不得 required", async () => {
    const rubricStore = new RubricStore(
      path.join(await createTempDir("rubric-contract-caps"), "rubrics"),
    );
    const builder = new RubricContractBuilder({
      rubricStore,
      now: () => "2026-01-01T00:00:00.000Z",
      evidenceCapabilities: { independentKinds: ["file-diff", "log"] },
      generationStrategy: new LLMRubricDraftGenerationStrategy({
        complete: async () =>
          JSON.stringify({
            title: "导出功能验收准则",
            description: "用于判断导出功能是否完成。",
            passCriteria: ["导出入口可用"],
            evidenceRequirements: [
              {
                id: "diff",
                kind: "file-diff",
                description: "核对导出功能相关文件变更。",
                required: true,
              },
              {
                id: "tests",
                kind: "test-result",
                description: "测试需要通过。",
                required: true,
              },
              {
                id: "log-no-locator",
                kind: "log",
                description: "查看导出日志。",
                required: true,
              },
              {
                id: "log-located",
                kind: "log",
                description: "查看导出日志文件。",
                required: true,
                locator: { paths: ["logs/export.log"] },
              },
            ],
            failureHandling: [
              { id: "continue", scenario: "未达标", reply: "请继续修正。" },
            ],
          }),
      }),
    });

    const draft = await builder.buildDraft({
      originalTurnId: "turn-caps",
      originalUserTask: userTurnInputFromText("请把导出功能做到可验收"),
    });

    const byId = new Map(
      draft.content.evidenceRequirements?.map((item) => [item.id, item]),
    );
    expect(byId.get("diff")?.required).toBe(true);
    expect(byId.get("tests")?.required).toBe(false);
    expect(byId.get("log-no-locator")?.required).toBe(false);
    expect(byId.get("log-located")?.required).toBe(true);
    expect(byId.get("log-located")?.locator).toEqual({
      paths: ["logs/export.log"],
    });
  });

  it("matched 路径在非空能力集下按 kind 收敛 required", async () => {
    const rubricStore = new RubricStore(
      path.join(await createTempDir("rubric-contract-matched-caps"), "rubrics"),
    );
    await rubricStore.saveOwn({
      title: "测试全绿推进准则",
      description: "用于测试全绿任务",
      content: {
        passCriteria: ["测试通过"],
        evidenceRequirements: ["测试结果需要通过", "核对相关文件 diff"],
        failureHandling: [
          { scenario: "测试失败", reply: "请修复失败测试后继续。" },
        ],
      },
    });
    const builder = new RubricContractBuilder({
      rubricStore,
      now: () => "2026-01-01T00:00:00.000Z",
      evidenceCapabilities: { independentKinds: ["file-diff"] },
    });

    const draft = await builder.buildDraft({
      originalTurnId: "turn-matched-caps",
      originalUserTask: userTurnInputFromText("请把测试全绿任务盯到验收通过"),
    });

    expect(draft.source).toBe("matched");
    const byKind = new Map(
      draft.content.evidenceRequirements?.map((item) => [item.kind, item]),
    );
    expect(byKind.get("test-result")?.required).toBe(false);
    expect(byKind.get("file-diff")?.required).toBe(true);
  });

  it("未注入能力集时任何客观要求都不得标 required", async () => {
    const rubricStore = new RubricStore(
      path.join(await createTempDir("rubric-contract-nocaps"), "rubrics"),
    );
    await rubricStore.saveOwn({
      title: "测试全绿推进准则",
      description: "用于测试全绿任务",
      content: {
        passCriteria: ["测试通过"],
        evidenceRequirements: ["测试结果需要通过"],
        failureHandling: [
          { scenario: "测试失败", reply: "请修复失败测试后继续。" },
        ],
      },
    });
    const builder = new RubricContractBuilder({
      rubricStore,
      now: () => "2026-01-01T00:00:00.000Z",
    });

    const draft = await builder.buildDraft({
      originalTurnId: "turn-nocaps",
      originalUserTask: userTurnInputFromText("请把测试全绿任务盯到验收通过"),
    });

    expect(draft.source).toBe("matched");
    expect(draft.content.evidenceRequirements?.[0]?.required).toBe(false);
  });

  it("确认固化时给通过标准按序分配恒稳条目 id", async () => {
    const rubricStore = new RubricStore(
      path.join(await createTempDir("rubric-contract-seal"), "rubrics"),
    );
    await rubricStore.saveOwn({
      title: "测试全绿推进准则",
      description: "用于测试全绿任务",
      content: {
        passCriteria: ["测试通过", "无回归"],
        evidenceRequirements: ["测试结果需要通过"],
        failureHandling: [
          { scenario: "测试失败", reply: "请修复失败测试后继续。" },
        ],
      },
    });
    const builder = new RubricContractBuilder({
      rubricStore,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const draft = await builder.buildDraft({
      originalTurnId: "turn-seal",
      originalUserTask: userTurnInputFromText("请把测试全绿任务盯到验收通过"),
    });

    const confirmed = await builder.confirmDraft(draft);

    expect(draft.content.passCriteria).toEqual(["测试通过", "无回归"]);
    expect(confirmed.content.passCriteria).toEqual([
      { id: "pc-1", text: "测试通过" },
      { id: "pc-2", text: "无回归" },
    ]);
    expect(confirmed.content.failureHandling).toEqual(
      draft.content.failureHandling,
    );
  });
});
