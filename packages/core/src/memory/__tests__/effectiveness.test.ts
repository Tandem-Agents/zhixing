import { describe, it, expect, beforeEach } from "vitest";
import { createTempDir } from "@zhixing/test-utils";

import { SkillsStore, type SkillMeta } from "../skills-store.js";
import {
  inferEffectiveness,
  applyEffectivenessUpdates,
  detectNegativeSignal,
  type InferenceInput,
} from "../effectiveness.js";
import type { Message } from "../../types/messages.js";

// ─── 测试辅助 ───

let store: SkillsStore;

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantMsg(text: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

function makeSkillMeta(overrides: Partial<SkillMeta> = {}): SkillMeta {
  return {
    title: "Test Skill",
    tags: ["test"],
    triggers: ["test trigger"],
    created: "2025-06-01",
    source: "conversation",
    version: 1,
    useCount: 0,
    effectiveness: "unknown",
    ...overrides,
  };
}

beforeEach(async () => {
  const tmpDir = await createTempDir("effect");
  store = new SkillsStore(tmpDir);
});

// ─── detectNegativeSignal ───

describe("detectNegativeSignal", () => {
  it("检测中文否定：这个方法不对", () => {
    const result = detectNegativeSignal(["这个方法不对，换一种试试"]);
    expect(result).toBeTruthy();
  });

  it("检测中文否定：方法过时了", () => {
    const result = detectNegativeSignal(["这个方法过时了"]);
    expect(result).toBeTruthy();
  });

  it("检测中文否定：过时了", () => {
    const result = detectNegativeSignal(["过时了，现在都用新方案"]);
    expect(result).toBeTruthy();
  });

  it("检测中文否定：不行", () => {
    const result = detectNegativeSignal(["不行，这样做有问题"]);
    expect(result).toBeTruthy();
  });

  it("检测英文否定：doesn't work", () => {
    const result = detectNegativeSignal(["This doesn't work in my case"]);
    expect(result).toBeTruthy();
  });

  it("检测英文否定：wrong approach", () => {
    const result = detectNegativeSignal(["That's the wrong approach"]);
    expect(result).toBeTruthy();
  });

  it("正常对话无否定信号", () => {
    const result = detectNegativeSignal(["谢谢，问题解决了", "效果很好"]);
    expect(result).toBeNull();
  });

  it("空消息列表无信号", () => {
    const result = detectNegativeSignal([]);
    expect(result).toBeNull();
  });
});

// ─── inferEffectiveness ───

describe("inferEffectiveness", () => {
  it("用户否定 → needs-update", async () => {
    await store.save("docker-debug", makeSkillMeta({ useCount: 5, effectiveness: "helpful" }), "排查步骤...");

    const input: InferenceInput = {
      injectedSkillIds: ["docker-debug"],
      turnMessages: [
        userMsg("docker 网络不通"),
        assistantMsg("根据技能，第一步检查网络模式..."),
        userMsg("这个方法不对，现在 Docker 版本改了"),
      ],
    };

    const result = await inferEffectiveness(input, store);
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]!.inferred).toBe("needs-update");
    expect(result.updates[0]!.previous).toBe("helpful");
    expect(result.updates[0]!.reason).toContain("negative-signal");
  });

  it("连续使用 3 次无否定 → helpful", async () => {
    await store.save("git-rebase", makeSkillMeta({ useCount: 3, effectiveness: "unknown" }), "rebase 步骤...");

    const input: InferenceInput = {
      injectedSkillIds: ["git-rebase"],
      turnMessages: [
        userMsg("帮我 rebase 一下"),
        assistantMsg("好的，按照技能步骤操作..."),
        userMsg("成功了，谢谢"),
      ],
    };

    const result = await inferEffectiveness(input, store);
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]!.inferred).toBe("helpful");
    expect(result.updates[0]!.reason).toContain("used-3-times");
  });

  it("使用次数不足 3 次 → 保持 unknown（无更新）", async () => {
    await store.save("new-skill", makeSkillMeta({ useCount: 2, effectiveness: "unknown" }), "...");

    const input: InferenceInput = {
      injectedSkillIds: ["new-skill"],
      turnMessages: [
        userMsg("测试一下"),
        assistantMsg("好的"),
      ],
    };

    const result = await inferEffectiveness(input, store);
    expect(result.updates).toHaveLength(0);
  });

  it("之前 needs-update 本次正常使用 → 恢复 unknown", async () => {
    await store.save("recovered", makeSkillMeta({ useCount: 1, effectiveness: "needs-update" }), "...");

    const input: InferenceInput = {
      injectedSkillIds: ["recovered"],
      turnMessages: [
        userMsg("再试一次"),
        assistantMsg("这次用更新后的方法..."),
        userMsg("好了，没问题"),
      ],
    };

    const result = await inferEffectiveness(input, store);
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]!.inferred).toBe("unknown");
    expect(result.updates[0]!.reason).toBe("used-normally-after-negative");
  });

  it("已经是 helpful 且无否定 → 不重复更新", async () => {
    await store.save("stable", makeSkillMeta({ useCount: 10, effectiveness: "helpful" }), "...");

    const input: InferenceInput = {
      injectedSkillIds: ["stable"],
      turnMessages: [
        userMsg("用这个方法"),
        assistantMsg("按照技能操作"),
      ],
    };

    const result = await inferEffectiveness(input, store);
    expect(result.updates).toHaveLength(0);
  });

  it("空注入列表 → 无更新", async () => {
    const result = await inferEffectiveness(
      { injectedSkillIds: [], turnMessages: [userMsg("你好")] },
      store,
    );
    expect(result.updates).toHaveLength(0);
  });

  it("技能不存在 → 跳过", async () => {
    const result = await inferEffectiveness(
      { injectedSkillIds: ["nonexistent"], turnMessages: [userMsg("你好")] },
      store,
    );
    expect(result.updates).toHaveLength(0);
  });

  it("多技能同时注入时各自独立推断", async () => {
    await store.save("skill-a", makeSkillMeta({ useCount: 5, effectiveness: "unknown" }), "A");
    await store.save("skill-b", makeSkillMeta({ useCount: 1, effectiveness: "unknown" }), "B");

    const input: InferenceInput = {
      injectedSkillIds: ["skill-a", "skill-b"],
      turnMessages: [
        userMsg("用技能"),
        assistantMsg("好的"),
      ],
    };

    const result = await inferEffectiveness(input, store);
    // skill-a: useCount=5 >= 3 → helpful
    // skill-b: useCount=1 < 3 → no update
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]!.skillId).toBe("skill-a");
    expect(result.updates[0]!.inferred).toBe("helpful");
  });
});

// ─── applyEffectivenessUpdates ───

describe("applyEffectivenessUpdates", () => {
  it("将推断结果持久化", async () => {
    await store.save("target", makeSkillMeta({ useCount: 3, effectiveness: "unknown" }), "...");

    const result = {
      updates: [{
        skillId: "target",
        previous: "unknown" as const,
        inferred: "helpful" as const,
        reason: "used-3-times-without-negative",
      }],
    };

    const applied = await applyEffectivenessUpdates(result, store);
    expect(applied).toBe(1);

    const reloaded = await store.load("target");
    expect(reloaded!.meta.effectiveness).toBe("helpful");
  });

  it("技能不存在时跳过", async () => {
    const result = {
      updates: [{
        skillId: "gone",
        previous: "unknown" as const,
        inferred: "helpful" as const,
        reason: "test",
      }],
    };

    const applied = await applyEffectivenessUpdates(result, store);
    expect(applied).toBe(0);
  });

  it("空更新列表 → 0 applied", async () => {
    const applied = await applyEffectivenessUpdates({ updates: [] }, store);
    expect(applied).toBe(0);
  });
});
