/**
 * TokenUsage 规范契约 —— 跨 adapter 一致性强制点（单一事实源）。
 *
 * 背景：vendor 对"输入 token"的上报语义分裂 ——
 *   - Anthropic：input_tokens 仅"未命中新输入"，cache 命中单列，不含在内
 *   - OpenAI 兼容族：prompt_tokens 本就是全量（含 cache 命中）
 *
 * 规范口径由 getTotalInputTokens 单点裁决：adapter 显式归一 totalInputTokens，
 * 或在 vendor 原值已是全量时 fallback 回 inputTokens。本测试对每个 adapter 的
 * usage 归一出口断言下述不变量；**新增 adapter 必须在此补 fixture**，否则契约
 * 无强制 —— 这是该契约可插拔、可回归的保证。
 *
 * 不变量：
 *   I1  getTotalInputTokens(u) ≥ u.inputTokens
 *   I2  getTotalInputTokens(u) ≥ (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
 *   I3  所有 token 计数非负
 *   I4  OpenAI 兼容族：getTotalInputTokens(u) === prompt_tokens（fallback 即正确）
 *   I5  Anthropic：inputTokens 保留 vendor 原值不变（anchor / 校准锚点零位移 ——
 *       这是"token 区不能变差"约束的回归守卫）
 */

import { describe, expect, it } from "vitest";
import { getTotalInputTokens, type TokenUsage } from "@zhixing/core";
import {
  extractUsage,
  type AnthropicUsageLike,
} from "../adapters/anthropic-messages.js";
import { parseOpenAICompatibleUsage } from "../adapters/openai-usage.js";

/** I1+I2+I3 —— 任何 adapter 出口的 TokenUsage 都必须满足的通用契约。 */
function assertCanonicalInvariants(u: TokenUsage): void {
  const total = getTotalInputTokens(u);
  const cacheSum = (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);

  expect(total).toBeGreaterThanOrEqual(u.inputTokens); // I1
  expect(total).toBeGreaterThanOrEqual(cacheSum); // I2
  expect(u.inputTokens).toBeGreaterThanOrEqual(0); // I3
  expect(u.outputTokens).toBeGreaterThanOrEqual(0);
  expect(total).toBeGreaterThanOrEqual(0);
  if (u.cacheReadTokens !== undefined)
    expect(u.cacheReadTokens).toBeGreaterThanOrEqual(0);
  if (u.cacheWriteTokens !== undefined)
    expect(u.cacheWriteTokens).toBeGreaterThanOrEqual(0);
}

describe("usage-conformance · Anthropic adapter", () => {
  it("cache 命中：totalInputTokens = input + read + write；inputTokens 保留原值（I5）", () => {
    const raw: AnthropicUsageLike = {
      input_tokens: 300,
      output_tokens: 50,
      cache_read_input_tokens: 48_000,
      cache_creation_input_tokens: 1_200,
    };
    const u = extractUsage(raw);

    // I5：anchor / estimator 校准读的是 inputTokens —— 必须逐字节等于 vendor 原值
    expect(u.inputTokens).toBe(300);
    expect(u.totalInputTokens).toBe(49_500);
    expect(getTotalInputTokens(u)).toBe(49_500);
    expect(u.cacheReadTokens).toBe(48_000);
    expect(u.cacheWriteTokens).toBe(1_200);
    assertCanonicalInvariants(u);
  });

  it("无 cache：total === input，inputTokens 原值", () => {
    const u = extractUsage({ input_tokens: 5_000, output_tokens: 120 });
    expect(u.inputTokens).toBe(5_000);
    expect(getTotalInputTokens(u)).toBe(5_000);
    expect(u.cacheReadTokens).toBeUndefined();
    expect(u.cacheWriteTokens).toBeUndefined();
    assertCanonicalInvariants(u);
  });

  it("cache 字段为 null：按 0 归一，不污染 total / 不误填 cache 字段", () => {
    const u = extractUsage({
      input_tokens: 800,
      output_tokens: 40,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    });
    expect(u.inputTokens).toBe(800);
    expect(getTotalInputTokens(u)).toBe(800);
    expect(u.cacheReadTokens).toBeUndefined();
    expect(u.cacheWriteTokens).toBeUndefined();
    assertCanonicalInvariants(u);
  });

  it("仅 cache_read（无 write）：total 含命中部分", () => {
    const u = extractUsage({
      input_tokens: 200,
      output_tokens: 30,
      cache_read_input_tokens: 12_000,
    });
    expect(u.inputTokens).toBe(200);
    expect(getTotalInputTokens(u)).toBe(12_200);
    expect(u.cacheReadTokens).toBe(12_000);
    expect(u.cacheWriteTokens).toBeUndefined();
    assertCanonicalInvariants(u);
  });
});

describe("usage-conformance · OpenAI 兼容族 adapter", () => {
  it("OpenAI 标准（含 cached）：getTotalInputTokens === prompt_tokens（I4，走 fallback）", () => {
    const u = parseOpenAICompatibleUsage({
      prompt_tokens: 8_000,
      completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: 6_000 },
    });
    expect(u.inputTokens).toBe(8_000);
    expect(u.totalInputTokens).toBeUndefined(); // 不显式设，契约靠 fallback
    expect(getTotalInputTokens(u)).toBe(8_000); // I4
    expect(u.cacheReadTokens).toBe(6_000);
    assertCanonicalInvariants(u);
  });

  it("DeepSeek（prompt_cache_hit）：getTotalInputTokens === prompt_tokens（I4）", () => {
    const u = parseOpenAICompatibleUsage({
      prompt_tokens: 9_000,
      completion_tokens: 300,
      prompt_cache_hit_tokens: 7_000,
    });
    expect(u.inputTokens).toBe(9_000);
    expect(getTotalInputTokens(u)).toBe(9_000); // I4
    expect(u.cacheReadTokens).toBe(7_000);
    assertCanonicalInvariants(u);
  });

  it("无 cache 信息的兜底：total === input", () => {
    const u = parseOpenAICompatibleUsage({
      prompt_tokens: 4_200,
      completion_tokens: 88,
    });
    expect(getTotalInputTokens(u)).toBe(4_200);
    assertCanonicalInvariants(u);
  });

  it("异常输入降级：仍满足规范不变量", () => {
    assertCanonicalInvariants(parseOpenAICompatibleUsage(null));
    assertCanonicalInvariants(parseOpenAICompatibleUsage({}));
    assertCanonicalInvariants(parseOpenAICompatibleUsage("garbage"));
  });
});
