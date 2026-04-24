import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../../types/llm.js";
import {
  CONSERVATIVE_FALLBACK,
  resolveModelInfo,
} from "../model-info-resolver.js";

// ─── Fixtures ───

const DEEPSEEK_CHAT: ModelInfo = {
  id: "deepseek-chat",
  name: "DeepSeek Chat",
  provider: "deepseek",
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
};

const DEEPSEEK_CODER: ModelInfo = {
  id: "deepseek-coder",
  name: "DeepSeek Coder",
  provider: "deepseek",
  contextWindow: 128_000,
  maxOutputTokens: 4_096,
};

// ─── declared 分支 ───

describe("resolveModelInfo · declared 精确匹配", () => {
  it("精确匹配时返回 declared 的 budget", () => {
    const result = resolveModelInfo({
      providerId: "deepseek",
      model: "deepseek-chat",
      providerModels: [DEEPSEEK_CHAT, DEEPSEEK_CODER],
    });
    expect(result.source).toBe("declared");
    expect(result.info).toEqual({
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
    });
    expect(result.warnings).toEqual([]);
  });

  it("未匹配但有第一个模型时使用 fallback declared + 产生 warning", () => {
    const result = resolveModelInfo({
      providerId: "deepseek",
      model: "typo-model-name",
      providerModels: [DEEPSEEK_CHAT, DEEPSEEK_CODER],
    });
    expect(result.source).toBe("declared");
    expect(result.info).toEqual({
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.code).toBe("MODEL_NOT_FOUND");
    expect(result.warnings[0]!.message).toContain("deepseek-chat");
  });
});

// ─── override 分支 ───

describe("resolveModelInfo · override", () => {
  it("完整 override 覆盖 declared 值", () => {
    const result = resolveModelInfo({
      providerId: "deepseek",
      model: "deepseek-chat",
      providerModels: [DEEPSEEK_CHAT],
      overrides: {
        "deepseek-chat": { contextWindow: 64_000, maxOutputTokens: 2_000 },
      },
    });
    expect(result.source).toBe("override");
    expect(result.info).toEqual({
      contextWindow: 64_000,
      maxOutputTokens: 2_000,
    });
    expect(result.warnings).toEqual([]);
  });

  it("部分 override 保留 declared 其他字段", () => {
    const result = resolveModelInfo({
      providerId: "deepseek",
      model: "deepseek-chat",
      providerModels: [DEEPSEEK_CHAT],
      overrides: {
        "deepseek-chat": { contextWindow: 64_000 },
      },
    });
    expect(result.source).toBe("override");
    expect(result.info).toEqual({
      contextWindow: 64_000,
      maxOutputTokens: 8_192, // 继承自 declared
    });
  });

  it("override 命中 + declared 未匹配 → 用 providerModels[0] 作 base 并带 warning", () => {
    const result = resolveModelInfo({
      providerId: "deepseek",
      model: "typo-name",
      providerModels: [DEEPSEEK_CHAT],
      overrides: {
        "typo-name": { contextWindow: 16_000 },
      },
    });
    expect(result.source).toBe("override");
    expect(result.info).toEqual({
      contextWindow: 16_000,
      maxOutputTokens: 8_192, // 继承自 declaredFallback
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.code).toBe("MODEL_NOT_FOUND");
  });

  it("override 命中 + providerModels 为空 → 基于 CONSERVATIVE_FALLBACK 合并", () => {
    const result = resolveModelInfo({
      providerId: "unknown",
      model: "mystery-model",
      providerModels: [],
      overrides: {
        "mystery-model": { contextWindow: 200_000 },
      },
    });
    expect(result.source).toBe("override");
    expect(result.info).toEqual({
      contextWindow: 200_000,
      maxOutputTokens: CONSERVATIVE_FALLBACK.maxOutputTokens,
    });
  });
});

// ─── fallback 分支 ───

describe("resolveModelInfo · fallback", () => {
  it("providerModels 为空 + 无 override → CONSERVATIVE_FALLBACK + 2 个 warning", () => {
    const result = resolveModelInfo({
      providerId: "unknown-provider",
      model: "unknown-model",
      providerModels: [],
    });
    expect(result.source).toBe("fallback");
    expect(result.info).toEqual(CONSERVATIVE_FALLBACK);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.map((w) => w.code)).toEqual([
      "NO_DECLARED_MODELS",
      "USING_FALLBACK",
    ]);
  });

  it("fallback 返回新对象副本（防止共享引用导致 CONSERVATIVE_FALLBACK 被改）", () => {
    const result = resolveModelInfo({
      providerId: "x",
      model: "y",
      providerModels: [],
    });
    expect(result.info).not.toBe(CONSERVATIVE_FALLBACK);
    expect(result.info).toEqual(CONSERVATIVE_FALLBACK);
  });
});

// ─── 调用方契约 ───

describe("resolveModelInfo · 调用方契约", () => {
  it("info 永远非 undefined（类型系统强制）", () => {
    const cases = [
      { providerId: "a", model: "x", providerModels: [] },
      { providerId: "a", model: "x", providerModels: [DEEPSEEK_CHAT] },
      {
        providerId: "a",
        model: "x",
        providerModels: [],
        overrides: { x: { contextWindow: 1 } },
      },
    ];
    for (const input of cases) {
      const result = resolveModelInfo(input);
      expect(result.info).toBeDefined();
      expect(result.info.contextWindow).toBeGreaterThan(0);
      expect(result.info.maxOutputTokens).toBeGreaterThan(0);
    }
  });

  it("warnings 总是数组（即使为空）", () => {
    const result = resolveModelInfo({
      providerId: "a",
      model: "deepseek-chat",
      providerModels: [DEEPSEEK_CHAT],
    });
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});
