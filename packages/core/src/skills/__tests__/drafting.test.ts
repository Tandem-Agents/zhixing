import { describe, it, expect } from "vitest";
import { draftSkill, reviseSkill, type SkillDraftLlm } from "../drafting.js";
import type { SkillDraft } from "../types.js";

/** mock LLM:记录收到的 prompt、按序返回预设响应。 */
function mkLlm(...responses: string[]): {
  llm: SkillDraftLlm;
  prompts: string[];
} {
  const prompts: string[] = [];
  let i = 0;
  return {
    prompts,
    llm: async (p) => {
      prompts.push(p);
      return responses[Math.min(i++, responses.length - 1)];
    },
  };
}

const json = (d: Partial<SkillDraft>): string => JSON.stringify(d);

describe("draftSkill", () => {
  it("从上下文 / 意图产结构化草稿", async () => {
    const { llm } = mkLlm(
      json({ name: "部署服务", description: "部署到生产时用", body: "先 build 再推", mode: "work" }),
    );
    const draft = await draftSkill(llm, {
      context: "我们刚部署完",
      intent: "记下部署做法",
      defaultMode: "main",
    });
    expect(draft).toEqual({
      name: "部署服务",
      description: "部署到生产时用",
      body: "先 build 再推",
      mode: "work",
    });
  });

  it("prompt 含上下文、意图与默认 mode", async () => {
    const { llm, prompts } = mkLlm(
      json({ name: "n", description: "d", body: "b", mode: "main" }),
    );
    await draftSkill(llm, {
      context: "上下文ABC",
      intent: "意图XYZ",
      defaultMode: "work",
    });
    expect(prompts[0]).toContain("上下文ABC");
    expect(prompts[0]).toContain("意图XYZ");
    expect(prompts[0]).toContain("work");
  });

  it("mode 无效 / 缺失 → 落默认", async () => {
    const { llm } = mkLlm(json({ name: "n", description: "d", body: "b" }));
    const draft = await draftSkill(llm, { intent: "x", defaultMode: "work" });
    expect(draft.mode).toBe("work");
  });

  it("草稿里的 secret 被脱敏、不进技能", async () => {
    const { llm } = mkLlm(
      json({
        name: "n",
        description: "d",
        body: "用 sk-proj1234567890abcdefghij1234 调用接口",
        mode: "main",
      }),
    );
    const draft = await draftSkill(llm, { intent: "x", defaultMode: "main" });
    expect(draft.body).not.toContain("sk-proj1234567890");
    expect(draft.body).toContain("«已脱敏");
  });

  it("从模型输出里夹带的文字中提取 JSON", async () => {
    const { llm } = mkLlm(
      `好的,草稿如下:\n${json({ name: "n", description: "d", body: "b", mode: "main" })}\n请确认。`,
    );
    const draft = await draftSkill(llm, { intent: "x", defaultMode: "main" });
    expect(draft.name).toBe("n");
  });
});

describe("draftSkill — 起草失败即抛(不兜底半成品)", () => {
  it("无 JSON → 抛", async () => {
    const { llm } = mkLlm("抱歉,我无法起草");
    await expect(
      draftSkill(llm, { intent: "x", defaultMode: "main" }),
    ).rejects.toThrow(/起草失败/);
  });

  it("缺 name → 抛", async () => {
    const { llm } = mkLlm(json({ description: "d", body: "b", mode: "main" }));
    await expect(
      draftSkill(llm, { intent: "x", defaultMode: "main" }),
    ).rejects.toThrow(/起草失败/);
  });

  it("JSON 损坏 → 抛", async () => {
    const { llm } = mkLlm('{"name": "n", "description": }');
    await expect(
      draftSkill(llm, { intent: "x", defaultMode: "main" }),
    ).rejects.toThrow(/起草失败/);
  });
});

describe("reviseSkill", () => {
  const base: SkillDraft = {
    name: "部署服务",
    description: "旧描述",
    body: "旧正文",
    mode: "main",
  };

  it("按指令产出改后草稿", async () => {
    const { llm } = mkLlm(
      json({ ...base, description: "部署到生产、需回滚时用" }),
    );
    const next = await reviseSkill(llm, base, "description 再尖一点");
    expect(next.description).toBe("部署到生产、需回滚时用");
    expect(next.name).toBe("部署服务");
  });

  it("prompt 含原草稿与修改指令;mode 缺省时保持原 mode", async () => {
    const { llm, prompts } = mkLlm(
      json({ name: "部署服务", description: "x", body: "y" }),
    );
    const next = await reviseSkill(llm, base, "改简洁点");
    expect(prompts[0]).toContain("旧正文");
    expect(prompts[0]).toContain("改简洁点");
    expect(next.mode).toBe("main");
  });
});
