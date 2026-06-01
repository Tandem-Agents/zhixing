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

const json = (d: Partial<SkillDraft> & { subject?: string }): string =>
  JSON.stringify(d);

describe("draftSkill", () => {
  it("返回 {draft, subject, redactionCount};draft 是结构化草稿内容", async () => {
    const { llm } = mkLlm(
      json({
        subject: "把生产部署流程收下来",
        name: "部署服务",
        description: "部署到生产时用",
        body: "先 build 再推",
        mode: "work",
      }),
    );
    const result = await draftSkill(llm, {
      context: "我们刚部署完",
      intent: "记下部署做法",
      defaultMode: "main",
    });
    expect(result.draft).toEqual({
      name: "部署服务",
      description: "部署到生产时用",
      body: "先 build 再推",
      mode: "work",
    });
    expect(result.subject).toBe("把生产部署流程收下来");
    expect(result.redactionCount).toBe(0);
  });

  it("subject 缺失时 fallback 到 description（不为空）", async () => {
    const { llm } = mkLlm(
      json({ name: "n", description: "要在 X 时用", body: "b", mode: "main" }),
    );
    const result = await draftSkill(llm, { intent: "x", defaultMode: "main" });
    expect(result.subject).toBe("要在 X 时用");
  });

  it("prompt 含上下文、意图、默认 mode 与 subject 输出契约", async () => {
    const { llm, prompts } = mkLlm(
      json({ subject: "s", name: "n", description: "d", body: "b", mode: "main" }),
    );
    await draftSkill(llm, {
      context: "上下文ABC",
      intent: "意图XYZ",
      defaultMode: "work",
    });
    expect(prompts[0]).toContain("上下文ABC");
    expect(prompts[0]).toContain("意图XYZ");
    expect(prompts[0]).toContain("work");
    expect(prompts[0]).toContain("subject"); // 首次起草 FORMAT 含 subject 字段
  });

  it("mode 无效 / 缺失 → 落默认", async () => {
    const { llm } = mkLlm(json({ name: "n", description: "d", body: "b" }));
    const result = await draftSkill(llm, { intent: "x", defaultMode: "work" });
    expect(result.draft.mode).toBe("work");
  });

  it("草稿里的 secret 被脱敏、不进技能,且 redactionCount 计数", async () => {
    const { llm } = mkLlm(
      json({
        subject: "s",
        name: "n",
        description: "d",
        body: "用 sk-proj1234567890abcdefghij1234 调用接口",
        mode: "main",
      }),
    );
    const result = await draftSkill(llm, { intent: "x", defaultMode: "main" });
    expect(result.draft.body).not.toContain("sk-proj1234567890");
    expect(result.draft.body).toContain("«已脱敏");
    expect(result.redactionCount).toBe(1);
  });

  it("subject 里的 secret 也被脱敏（不计入 redactionCount —— 它不是草稿内容）", async () => {
    const { llm } = mkLlm(
      json({
        subject: "记下 sk-proj1234567890abcdefghij1234 的用法",
        name: "n",
        description: "d",
        body: "b",
        mode: "main",
      }),
    );
    const result = await draftSkill(llm, { intent: "x", defaultMode: "main" });
    expect(result.subject).not.toContain("sk-proj1234567890");
    expect(result.subject).toContain("«已脱敏");
    expect(result.redactionCount).toBe(0); // 草稿三字段无 secret
  });

  it("从模型输出里夹带的文字中提取 JSON", async () => {
    const { llm } = mkLlm(
      `好的,草稿如下:\n${json({ name: "n", description: "d", body: "b", mode: "main" })}\n请确认。`,
    );
    const result = await draftSkill(llm, { intent: "x", defaultMode: "main" });
    expect(result.draft.name).toBe("n");
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

  it("返回 {draft, redactionCount}(无 subject —— 改写不换主题)", async () => {
    const { llm } = mkLlm(json({ ...base, description: "部署到生产、需回滚时用" }));
    const result = await reviseSkill(llm, base, "description 再尖一点");
    expect(result.draft.description).toBe("部署到生产、需回滚时用");
    expect(result.draft.name).toBe("部署服务");
    expect(result.redactionCount).toBe(0);
    expect("subject" in result).toBe(false);
  });

  it("prompt 含原草稿与修改指令、不含 subject 契约;mode 缺省保持原 mode", async () => {
    const { llm, prompts } = mkLlm(
      json({ name: "部署服务", description: "x", body: "y" }),
    );
    const result = await reviseSkill(llm, base, "改简洁点");
    expect(prompts[0]).toContain("旧正文");
    expect(prompts[0]).toContain("改简洁点");
    expect(prompts[0]).not.toContain('"subject"'); // 改写 FORMAT 不含 subject
    expect(result.draft.mode).toBe("main");
  });

  it("改写引入的 secret 也被脱敏、计入 redactionCount", async () => {
    const { llm } = mkLlm(
      json({ ...base, body: "key=AKIAIOSFODNN7EXAMPLE 用它" }),
    );
    const result = await reviseSkill(llm, base, "加一行");
    expect(result.draft.body).toContain("«已脱敏");
    expect(result.redactionCount).toBe(1);
  });
});
