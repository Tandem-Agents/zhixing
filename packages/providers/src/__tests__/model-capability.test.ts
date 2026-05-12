import { describe, expect, it } from "vitest";

import {
  MODEL_CAPABILITIES,
  UNKNOWN_MODEL_CAPABILITY,
  getModelCapabilityOverride,
  normalizeModelId,
  resolveModelCapability,
  type ModelCapabilityOverride,
} from "../model-capability.js";

describe("MODEL_CAPABILITIES 内置常量", () => {
  it("DeepSeek V4 Pro：128K / 256K", () => {
    const cap = MODEL_CAPABILITIES["deepseek-v4-pro"];
    expect(cap).toBeDefined();
    expect(cap!.optimalMaxTokens).toBe(128_000);
    expect(cap!.riskMaxTokens).toBe(256_000);
  });

  it("DeepSeek V4 Flash：32K / 64K（保守阈值）", () => {
    const cap = MODEL_CAPABILITIES["deepseek-v4-flash"];
    expect(cap).toBeDefined();
    expect(cap!.optimalMaxTokens).toBe(32_000);
    expect(cap!.riskMaxTokens).toBe(64_000);
  });

  it("不变量：每个模型 optimalMaxTokens < riskMaxTokens", () => {
    for (const [id, cap] of Object.entries(MODEL_CAPABILITIES)) {
      expect(cap.optimalMaxTokens, `${id}: optimal < risk`).toBeLessThan(
        cap.riskMaxTokens,
      );
    }
  });

  it("不变量：modelId 字段与索引键一致", () => {
    for (const [id, cap] of Object.entries(MODEL_CAPABILITIES)) {
      expect(cap.modelId).toBe(id);
    }
  });
});

describe("UNKNOWN_MODEL_CAPABILITY 兜底", () => {
  it("optimal 16K / risk 32K（业界基线保守值）", () => {
    expect(UNKNOWN_MODEL_CAPABILITY.optimalMaxTokens).toBe(16_000);
    expect(UNKNOWN_MODEL_CAPABILITY.riskMaxTokens).toBe(32_000);
  });

  it("modelId 标记为 <unknown>", () => {
    expect(UNKNOWN_MODEL_CAPABILITY.modelId).toBe("<unknown>");
  });
});

describe("resolveModelCapability", () => {
  it("完全匹配命中内置常量", () => {
    const cap = resolveModelCapability("deepseek-v4-pro");
    expect(cap.optimalMaxTokens).toBe(128_000);
    expect(cap.riskMaxTokens).toBe(256_000);
  });

  it("大小写不敏感", () => {
    const cap = resolveModelCapability("DeepSeek-V4-Pro");
    expect(cap.modelId).toBe("deepseek-v4-pro");
    expect(cap.optimalMaxTokens).toBe(128_000);
  });

  it("未知模型走 UNKNOWN 兜底（modelId 保留规范化后的查询键）", () => {
    const cap = resolveModelCapability("Some-Vendor-LLM");
    expect(cap.modelId).toBe("some-vendor-llm");
    expect(cap.optimalMaxTokens).toBe(16_000);
    expect(cap.riskMaxTokens).toBe(32_000);
  });

  it("override 单字段覆盖：其他字段从内置常量继承", () => {
    const cap = resolveModelCapability("deepseek-v4-pro", {
      optimalMaxTokens: 96_000,
    });
    expect(cap.optimalMaxTokens).toBe(96_000);
    expect(cap.riskMaxTokens).toBe(256_000); // 内置值不变
  });

  it("override 多字段覆盖", () => {
    const cap = resolveModelCapability("deepseek-v4-pro", {
      optimalMaxTokens: 96_000,
      riskMaxTokens: 192_000,
    });
    expect(cap.optimalMaxTokens).toBe(96_000);
    expect(cap.riskMaxTokens).toBe(192_000);
  });

  it("override 在未知模型上：从 UNKNOWN 兜底继承缺省字段", () => {
    const cap = resolveModelCapability("unknown-x", {
      optimalMaxTokens: 24_000,
    });
    expect(cap.optimalMaxTokens).toBe(24_000); // override 生效
    expect(cap.riskMaxTokens).toBe(32_000); // UNKNOWN 兜底值
  });

  it("空 override 对象等价于不传 override", () => {
    const cap = resolveModelCapability("deepseek-v4-flash", {});
    expect(cap.optimalMaxTokens).toBe(32_000);
    expect(cap.riskMaxTokens).toBe(64_000);
  });
});

describe("normalizeModelId —— vendor 前缀剥除", () => {
  it("无 '/' 直接 lowercase", () => {
    expect(normalizeModelId("deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(normalizeModelId("GPT-4-Turbo")).toBe("gpt-4-turbo");
  });

  it("siliconflow / huggingface 风格 vendor/model 前缀", () => {
    expect(normalizeModelId("deepseek-ai/DeepSeek-V4-Flash")).toBe(
      "deepseek-v4-flash",
    );
    expect(normalizeModelId("Qwen/Qwen3-30B-A3B-Instruct-2507")).toBe(
      "qwen3-30b-a3b-instruct-2507",
    );
  });

  it("fireworks 多级前缀只取最后一段", () => {
    expect(normalizeModelId("accounts/fireworks/models/llama-v3-70b")).toBe(
      "llama-v3-70b",
    );
  });

  it("空字符串 → 空字符串(防御性,不抛错)", () => {
    expect(normalizeModelId("")).toBe("");
  });

  it("仅 '/' 结尾 → 空字符串", () => {
    expect(normalizeModelId("prefix/")).toBe("");
  });
});

describe("resolveModelCapability 端到端 —— vendor 前缀命中内置表", () => {
  it("带 'deepseek-ai/' 前缀的 DeepSeek-V4-Flash 命中内置 deepseek-v4-flash", () => {
    const cap = resolveModelCapability("deepseek-ai/DeepSeek-V4-Flash");
    expect(cap.modelId).toBe("deepseek-v4-flash");
    expect(cap.optimalMaxTokens).toBe(32_000);
    expect(cap.riskMaxTokens).toBe(64_000);
  });

  it("用户 LLMRole.capability override 在内置之上覆盖单字段", () => {
    const cap = resolveModelCapability("deepseek-ai/DeepSeek-V4-Flash", {
      optimalMaxTokens: 3000,
      riskMaxTokens: 5000,
    });
    expect(cap.optimalMaxTokens).toBe(3000);
    expect(cap.riskMaxTokens).toBe(5000);
  });

  it("override 单字段 + 内置兜底另一字段", () => {
    const cap = resolveModelCapability("deepseek-ai/DeepSeek-V4-Pro", {
      optimalMaxTokens: 100_000,
    });
    expect(cap.optimalMaxTokens).toBe(100_000);
    expect(cap.riskMaxTokens).toBe(256_000); // 内置值不变
  });

  it("不在内置表的 model + 无 override → UNKNOWN 兜底", () => {
    const cap = resolveModelCapability("vendor/unknown-model-x");
    expect(cap.modelId).toBe("unknown-model-x");
    expect(cap.optimalMaxTokens).toBe(16_000);
    expect(cap.riskMaxTokens).toBe(32_000);
  });
});

describe("getModelCapabilityOverride —— normalize 双向匹配", () => {
  it("undefined overrides → undefined", () => {
    expect(
      getModelCapabilityOverride(undefined, "deepseek-v4-pro"),
    ).toBeUndefined();
  });

  it("空 map → undefined", () => {
    expect(
      getModelCapabilityOverride({}, "deepseek-v4-pro"),
    ).toBeUndefined();
  });

  it("key normalize 形式 + query normalize 形式 → O(1) 命中", () => {
    const overrides: Record<string, ModelCapabilityOverride> = {
      "deepseek-v4-flash": { optimalMaxTokens: 3000, riskMaxTokens: 5000 },
    };
    expect(getModelCapabilityOverride(overrides, "deepseek-v4-flash")).toEqual({
      optimalMaxTokens: 3000,
      riskMaxTokens: 5000,
    });
  });

  it("key 带 vendor 前缀 + query normalize 形式 → 命中（兜底扫描）", () => {
    const overrides: Record<string, ModelCapabilityOverride> = {
      "deepseek-ai/DeepSeek-V4-Flash": { optimalMaxTokens: 3000 },
    };
    expect(getModelCapabilityOverride(overrides, "deepseek-v4-flash")).toEqual(
      { optimalMaxTokens: 3000 },
    );
  });

  it("key normalize 形式 + query 带 vendor 前缀 → 命中", () => {
    const overrides: Record<string, ModelCapabilityOverride> = {
      "deepseek-v4-flash": { optimalMaxTokens: 3000 },
    };
    expect(
      getModelCapabilityOverride(overrides, "deepseek-ai/DeepSeek-V4-Flash"),
    ).toEqual({ optimalMaxTokens: 3000 });
  });

  it("key 大小写混合 + query 任意大小写 → 命中（normalize 双侧）", () => {
    const overrides: Record<string, ModelCapabilityOverride> = {
      "DeepSeek-V4-Pro": { optimalMaxTokens: 96_000 },
    };
    expect(getModelCapabilityOverride(overrides, "deepseek-v4-pro")).toEqual({
      optimalMaxTokens: 96_000,
    });
    expect(getModelCapabilityOverride(overrides, "DEEPSEEK-V4-PRO")).toEqual({
      optimalMaxTokens: 96_000,
    });
  });

  it("未匹配（normalize 后也无对应 key）→ undefined", () => {
    const overrides: Record<string, ModelCapabilityOverride> = {
      "deepseek-v4-flash": { optimalMaxTokens: 3000 },
    };
    expect(
      getModelCapabilityOverride(overrides, "claude-3-opus"),
    ).toBeUndefined();
  });

  it("切换 model 语义：用户改 main.model 后旧 override 不再套用", () => {
    // 用户配置覆盖 Flash 阈值
    const overrides: Record<string, ModelCapabilityOverride> = {
      "deepseek-ai/DeepSeek-V4-Flash": {
        optimalMaxTokens: 3000,
        riskMaxTokens: 5000,
      },
    };
    // 切换主模型到 Pro → Flash 的 override 不应命中 Pro
    expect(
      getModelCapabilityOverride(overrides, "deepseek-ai/DeepSeek-V4-Pro"),
    ).toBeUndefined();
  });

  it("端到端：resolveModelCapability 接收 getOverride 结果，覆盖单字段", () => {
    const overrides: Record<string, ModelCapabilityOverride> = {
      "deepseek-ai/DeepSeek-V4-Flash": {
        optimalMaxTokens: 3000,
        riskMaxTokens: 5000,
      },
    };
    const cap = resolveModelCapability(
      "deepseek-ai/DeepSeek-V4-Flash",
      getModelCapabilityOverride(overrides, "deepseek-ai/DeepSeek-V4-Flash"),
    );
    expect(cap.optimalMaxTokens).toBe(3000);
    expect(cap.riskMaxTokens).toBe(5000);
  });
});
