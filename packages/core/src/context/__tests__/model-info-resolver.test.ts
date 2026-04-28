import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../../types/llm.js";
import type { ModelBudgetInfo } from "../budget.js";
import {
  CONSERVATIVE_FALLBACK,
  resolveModelInfo,
} from "../model-info-resolver.js";

// ─── Fixtures ───

const DEEPSEEK_CHAT: ModelInfo = {
  id: "deepseek-chat",
  name: "DeepSeek Chat",
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
};

const DEEPSEEK_CODER: ModelInfo = {
  id: "deepseek-coder",
  name: "DeepSeek Coder",
  contextWindow: 128_000,
  maxOutputTokens: 4_096,
};

const OPENAI_COMPATIBLE_PROTOCOL_DEFAULTS: ModelBudgetInfo = {
  contextWindow: 128_000,
  maxOutputTokens: 4_096,
};

// ─── declared 分支 ───

describe("resolveModelInfo · declared 精确匹配", () => {
  it("精确匹配时返回 declared 的 budget，无 warning", () => {
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
});

// ─── protocol-default 分支（取代旧的 providerModels[0] 兜底） ───

describe("resolveModelInfo · protocol-default", () => {
  it("declared 未匹配 + 提供 protocolDefaults → 使用 protocol 默认，无 warning", () => {
    const result = resolveModelInfo({
      providerId: "siliconflow",
      model: "Pro/MiniMaxAI/MiniMax-M2.5",
      providerModels: [],
      protocolDefaults: OPENAI_COMPATIBLE_PROTOCOL_DEFAULTS,
    });
    expect(result.source).toBe("protocol-default");
    expect(result.info).toEqual(OPENAI_COMPATIBLE_PROTOCOL_DEFAULTS);
    expect(result.warnings).toEqual([]);
  });

  it("catalog 有其他 model 但请求 model 未匹配 → 走 protocol-default，不再用 catalog[0] 当伪占位", () => {
    const result = resolveModelInfo({
      providerId: "deepseek",
      model: "typo-model-name",
      providerModels: [DEEPSEEK_CHAT, DEEPSEEK_CODER],
      protocolDefaults: OPENAI_COMPATIBLE_PROTOCOL_DEFAULTS,
    });
    expect(result.source).toBe("protocol-default");
    expect(result.info).toEqual(OPENAI_COMPATIBLE_PROTOCOL_DEFAULTS);
    expect(result.warnings).toEqual([]);
  });

  it("返回 protocolDefaults 副本（防止共享引用被改）", () => {
    const result = resolveModelInfo({
      providerId: "x",
      model: "y",
      providerModels: [],
      protocolDefaults: OPENAI_COMPATIBLE_PROTOCOL_DEFAULTS,
    });
    expect(result.info).not.toBe(OPENAI_COMPATIBLE_PROTOCOL_DEFAULTS);
    expect(result.info).toEqual(OPENAI_COMPATIBLE_PROTOCOL_DEFAULTS);
  });
});

// ─── override 分支 ───

describe("resolveModelInfo · override", () => {
  it("override + declared 命中 → 在 declared 上叠加", () => {
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

  it("部分 override + declared 命中 → 缺失字段继承 declared", () => {
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
      maxOutputTokens: 8_192,
    });
  });

  it("override 命中 + declared 未命中 + 有 protocolDefaults → 在 protocolDefaults 上叠加", () => {
    const result = resolveModelInfo({
      providerId: "siliconflow",
      model: "custom-model",
      providerModels: [],
      protocolDefaults: OPENAI_COMPATIBLE_PROTOCOL_DEFAULTS,
      overrides: {
        "custom-model": { contextWindow: 256_000 },
      },
    });
    expect(result.source).toBe("override");
    expect(result.info).toEqual({
      contextWindow: 256_000,
      maxOutputTokens: 4_096,
    });
    expect(result.warnings).toEqual([]);
  });

  it("override 命中 + 无 declared 无 protocolDefaults → 在 CONSERVATIVE_FALLBACK 上叠加", () => {
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

// ─── fallback 分支（defensive，生产路径不应触达） ───

describe("resolveModelInfo · fallback (defensive)", () => {
  it("无 override + catalog 未命中 + 无 protocolDefaults → CONSERVATIVE_FALLBACK + USING_FALLBACK warning", () => {
    const result = resolveModelInfo({
      providerId: "unknown-provider",
      model: "unknown-model",
      providerModels: [],
    });
    expect(result.source).toBe("fallback");
    expect(result.info).toEqual(CONSERVATIVE_FALLBACK);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.code).toBe("USING_FALLBACK");
    expect(result.warnings[0]!.message).toContain("protocolDefaults");
  });

  it("fallback 返回新对象副本（防止共享引用）", () => {
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
      {
        providerId: "a",
        model: "x",
        providerModels: [],
        protocolDefaults: OPENAI_COMPATIBLE_PROTOCOL_DEFAULTS,
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
