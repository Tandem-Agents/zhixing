import { describe, expect, it } from "vitest";
import {
  ConservativeAdvancementAdmissionStrategy,
  LLMAdvancementAdmissionStrategy,
} from "../admission.js";
import { userTurnInputFromText } from "../../types/user-input.js";

describe("ConservativeAdvancementAdmissionStrategy", () => {
  const strategy = new ConservativeAdvancementAdmissionStrategy();

  it("初始准入失败时不启动重型推进", async () => {
    await expect(
      strategy.decide({
        input: userTurnInputFromText("请帮我改到测试全绿"),
      }),
    ).resolves.toEqual({
      kind: "direct-task",
      action: "run-direct",
      reason: "admission-unavailable",
    });
  });

  it("待确认阶段失败时保持等待", async () => {
    await expect(
      strategy.decide({
        input: userTurnInputFromText("取消这次任务"),
        hasOpenAdvancementSession: true,
      }),
    ).resolves.toEqual({
      kind: "question",
      action: "keep-awaiting-confirmation",
      reason: "admission-unavailable",
    });
  });
});

describe("LLMAdvancementAdmissionStrategy", () => {
  it("初始准入由 LLM 语义判断推进任务", async () => {
    const prompts: string[] = [];
    const strategy = new LLMAdvancementAdmissionStrategy({
      complete: async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({
          kind: "advancement-task",
          reason: "用户要求测试全绿并验收通过",
        });
      },
    });

    await expect(
      strategy.decide({
        input: userTurnInputFromText("别确认了，帮我改到测试全绿，盯到验收通过"),
      }),
    ).resolves.toEqual({
      kind: "advancement-task",
      action: "start-advancement",
      reason: "用户要求测试全绿并验收通过",
    });
    expect(prompts).toHaveLength(1);
  });

  it("初始准入由 LLM 语义判断普通任务", async () => {
    const strategy = new LLMAdvancementAdmissionStrategy({
      complete: async () =>
        JSON.stringify({
          kind: "direct-task",
          reason: "用户只要求一次普通执行",
        }),
    });

    await expect(
      strategy.decide({
        input: userTurnInputFromText("直接做一下这个小改动"),
      }),
    ).resolves.toEqual({
      kind: "direct-task",
      action: "run-direct",
      reason: "用户只要求一次普通执行",
    });
  });

  it("待确认阶段由 LLM 语义判断降级", async () => {
    const strategy = new LLMAdvancementAdmissionStrategy({
      complete: async () =>
        JSON.stringify({
          action: "downgrade-to-direct",
          reason: "用户明确跳过确认并直接执行原任务",
        }),
    });

    await expect(
      strategy.decide({
        input: userTurnInputFromText("别走 Rubric 确认了，直接执行原任务"),
        hasOpenAdvancementSession: true,
      }),
    ).resolves.toEqual({
      kind: "direct-task",
      action: "downgrade-to-direct",
      reason: "用户明确跳过确认并直接执行原任务",
    });
  });

  it("待确认阶段由 LLM 语义判断取消", async () => {
    const strategy = new LLMAdvancementAdmissionStrategy({
      complete: async () =>
        JSON.stringify({
          action: "cancel-pending-task",
          reason: "用户取消待确认任务",
        }),
    });

    await expect(
      strategy.decide({
        input: userTurnInputFromText("取消这次任务，原任务也不要做"),
        hasOpenAdvancementSession: true,
      }),
    ).resolves.toEqual({
      kind: "question",
      action: "cancel-pending-task",
      reason: "用户取消待确认任务",
    });
  });

  it("待确认阶段冲突或不确定表达由 LLM 保持等待", async () => {
    const strategy = new LLMAdvancementAdmissionStrategy({
      complete: async () =>
        JSON.stringify({
          action: "keep-awaiting-confirmation",
          reason: "表达存在冲突，需要继续等待确认",
        }),
    });

    await expect(
      strategy.decide({
        input: userTurnInputFromText("不用确认，但还是盯到验收通过"),
        hasOpenAdvancementSession: true,
      }),
    ).resolves.toEqual({
      kind: "question",
      action: "keep-awaiting-confirmation",
      reason: "表达存在冲突，需要继续等待确认",
    });
  });

  it("LLM 输出无效时按状态保守失败", async () => {
    const strategy = new LLMAdvancementAdmissionStrategy({
      complete: async () => "not json",
    });

    await expect(
      strategy.decide({
        input: userTurnInputFromText("请持续推进到完成"),
      }),
    ).resolves.toEqual({
      kind: "direct-task",
      action: "run-direct",
      reason: "admission-unavailable",
    });

    await expect(
      strategy.decide({
        input: userTurnInputFromText("取消这次任务"),
        hasOpenAdvancementSession: true,
      }),
    ).resolves.toEqual({
      kind: "question",
      action: "keep-awaiting-confirmation",
      reason: "admission-unavailable",
    });
  });
});
