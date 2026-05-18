/**
 * 思考方言映射纯函数测试 —— 验证各家原生形态 1:1 还原、未配不发、
 * 不支持形态安全兜底（"不发" 优于 "发错"）。
 */

import { describe, expect, it } from "vitest";
import {
  buildAnthropicThinkingParam,
  buildOpenAICompatibleThinkingParams,
} from "../adapters/thinking-params.js";

describe("buildOpenAICompatibleThinkingParams", () => {
  it("thinking 缺省 → 不发任何思考参数", () => {
    expect(
      buildOpenAICompatibleThinkingParams("deepseek", undefined),
    ).toEqual({});
    expect(buildOpenAICompatibleThinkingParams("qwen", undefined)).toEqual({});
  });

  it("none 方言 → 永不发思考参数", () => {
    expect(
      buildOpenAICompatibleThinkingParams("none", { mode: "on" }),
    ).toEqual({});
    expect(
      buildOpenAICompatibleThinkingParams("none", { mode: "effort", effort: "high" }),
    ).toEqual({});
  });

  it("deepseek → thinking{type} 开关 + reasoning_effort 离散档", () => {
    expect(
      buildOpenAICompatibleThinkingParams("deepseek", { mode: "off" }),
    ).toEqual({ thinking: { type: "disabled" } });
    expect(
      buildOpenAICompatibleThinkingParams("deepseek", { mode: "on" }),
    ).toEqual({ thinking: { type: "enabled" } });
    expect(
      buildOpenAICompatibleThinkingParams("deepseek", {
        mode: "effort",
        effort: "max",
      }),
    ).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "max" });
    // budget 不适用 deepseek（控制形态为 effort）→ 不发
    expect(
      buildOpenAICompatibleThinkingParams("deepseek", {
        mode: "budget",
        budget: 1024,
      }),
    ).toEqual({});
  });

  it("qwen → enable_thinking(bool) + thinking_budget(token 数)", () => {
    expect(
      buildOpenAICompatibleThinkingParams("qwen", { mode: "off" }),
    ).toEqual({ enable_thinking: false });
    expect(
      buildOpenAICompatibleThinkingParams("qwen", { mode: "on" }),
    ).toEqual({ enable_thinking: true });
    expect(
      buildOpenAICompatibleThinkingParams("qwen", {
        mode: "budget",
        budget: 4096,
      }),
    ).toEqual({ enable_thinking: true, thinking_budget: 4096 });
    // effort 不适用 qwen（连续预算维度）→ 不发
    expect(
      buildOpenAICompatibleThinkingParams("qwen", {
        mode: "effort",
        effort: "high",
      }),
    ).toEqual({});
  });

  it("glm / kimi → thinking.type 纯开关，强度/预算不适用", () => {
    for (const dialect of ["glm", "kimi"] as const) {
      expect(
        buildOpenAICompatibleThinkingParams(dialect, { mode: "off" }),
      ).toEqual({ thinking: { type: "disabled" } });
      expect(
        buildOpenAICompatibleThinkingParams(dialect, { mode: "on" }),
      ).toEqual({ thinking: { type: "enabled" } });
      expect(
        buildOpenAICompatibleThinkingParams(dialect, {
          mode: "effort",
          effort: "high",
        }),
      ).toEqual({});
    }
  });
});

describe("buildAnthropicThinkingParam", () => {
  it("缺省 → undefined（标准模式，不进入 extended thinking）", () => {
    expect(buildAnthropicThinkingParam(undefined)).toBeUndefined();
  });

  it("budget → thinking{type:enabled, budget_tokens}", () => {
    expect(buildAnthropicThinkingParam({ mode: "budget", budget: 10000 })).toEqual(
      { type: "enabled", budget_tokens: 10000 },
    );
  });

  it("off / on / effort → undefined（Anthropic budget_tokens 必填，不臆造数值）", () => {
    expect(buildAnthropicThinkingParam({ mode: "off" })).toBeUndefined();
    expect(buildAnthropicThinkingParam({ mode: "on" })).toBeUndefined();
    expect(
      buildAnthropicThinkingParam({ mode: "effort", effort: "high" }),
    ).toBeUndefined();
  });
});
