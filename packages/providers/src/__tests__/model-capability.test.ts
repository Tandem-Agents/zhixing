import { describe, expect, it } from "vitest";

import {
  MODEL_CAPABILITIES,
  UNKNOWN_MODEL_CAPABILITY,
  resolveModelCapability,
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
