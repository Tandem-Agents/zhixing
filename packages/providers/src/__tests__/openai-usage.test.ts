/**
 * OpenAI 兼容协议 usage 方言归一测试
 *
 * 三个验证维度:
 *   1. 各方言独立解析(OpenAI 标准 / DeepSeek)
 *   2. 派发策略(显式 dialect / auto 嗅探链 / fallback)
 *   3. 健壮性(异常输入不抛错、降级保 base 计数)
 *
 * 与 anthropic-messages 一致性: cache 字段 truthy 检查 —— 0 与 undefined 等价
 * "无明显命中",不填字段。这与 mergeUsage 的合并语义自洽。
 */

import { describe, expect, it } from "vitest";
import { parseOpenAICompatibleUsage } from "../adapters/openai-usage.js";

describe("parseOpenAICompatibleUsage", () => {
  describe("OpenAI 标准方言", () => {
    it("解析 prompt_tokens_details.cached_tokens", () => {
      const usage = parseOpenAICompatibleUsage(
        {
          prompt_tokens: 1200,
          completion_tokens: 300,
          total_tokens: 1500,
          prompt_tokens_details: { cached_tokens: 800 },
        },
        "openai-standard",
      );

      expect(usage.inputTokens).toBe(1200);
      expect(usage.outputTokens).toBe(300);
      expect(usage.cacheReadTokens).toBe(800);
      // OpenAI 兼容协议无 cache_write 概念
      expect(usage.cacheWriteTokens).toBeUndefined();
    });

    it("无 prompt_tokens_details 字段时不填 cacheReadTokens", () => {
      const usage = parseOpenAICompatibleUsage(
        { prompt_tokens: 100, completion_tokens: 50 },
        "openai-standard",
      );

      expect(usage.inputTokens).toBe(100);
      expect(usage.outputTokens).toBe(50);
      expect(usage.cacheReadTokens).toBeUndefined();
    });

    it("cached_tokens=0 不填字段(与 anthropic 适配器 truthy 检查一致)", () => {
      const usage = parseOpenAICompatibleUsage(
        {
          prompt_tokens: 100,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 0 },
        },
        "openai-standard",
      );

      expect(usage.cacheReadTokens).toBeUndefined();
    });

    it("缺失 completion_tokens 时回落到 0", () => {
      const usage = parseOpenAICompatibleUsage(
        { prompt_tokens: 100 },
        "openai-standard",
      );

      expect(usage.inputTokens).toBe(100);
      expect(usage.outputTokens).toBe(0);
    });
  });

  describe("DeepSeek 方言", () => {
    it("解析 prompt_cache_hit_tokens", () => {
      const usage = parseOpenAICompatibleUsage(
        {
          prompt_tokens: 1500,
          completion_tokens: 200,
          prompt_cache_hit_tokens: 1200,
          prompt_cache_miss_tokens: 300,
        },
        "deepseek",
      );

      expect(usage.inputTokens).toBe(1500);
      expect(usage.outputTokens).toBe(200);
      expect(usage.cacheReadTokens).toBe(1200);
      // DeepSeek 服务端自动缓存,无 cache_write
      expect(usage.cacheWriteTokens).toBeUndefined();
    });

    it("hit=0 不填 cacheReadTokens(全 miss 场景)", () => {
      const usage = parseOpenAICompatibleUsage(
        {
          prompt_tokens: 1500,
          completion_tokens: 200,
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: 1500,
        },
        "deepseek",
      );

      expect(usage.cacheReadTokens).toBeUndefined();
    });
  });

  describe("Auto 嗅探链", () => {
    it("DeepSeek 字段优先于 OpenAI 标准 —— 含 prompt_cache_hit_tokens 时走 DeepSeek parser", () => {
      // 假设(假想边界): vendor 同时返回两套字段
      // DeepSeek parser 在嗅探链首位 → 命中并短路,即使存在 prompt_tokens_details
      const usage = parseOpenAICompatibleUsage({
        prompt_tokens: 1500,
        completion_tokens: 200,
        prompt_cache_hit_tokens: 1200,
        // 即使带 OpenAI 标准的 details 字段,DeepSeek parser 仍优先
        prompt_tokens_details: { cached_tokens: 999 },
      });

      // 1200 来自 DeepSeek parser,不是 999(OpenAI 标准)
      expect(usage.cacheReadTokens).toBe(1200);
    });

    it("无 DeepSeek 特征字段时回落 OpenAI 标准", () => {
      const usage = parseOpenAICompatibleUsage({
        prompt_tokens: 1200,
        completion_tokens: 300,
        prompt_tokens_details: { cached_tokens: 800 },
      });

      expect(usage.cacheReadTokens).toBe(800);
    });

    it("dialect 未指定时默认 auto", () => {
      const explicit = parseOpenAICompatibleUsage(
        { prompt_tokens: 100, completion_tokens: 50 },
        "auto",
      );
      const implicit = parseOpenAICompatibleUsage({
        prompt_tokens: 100,
        completion_tokens: 50,
      });

      expect(implicit).toEqual(explicit);
    });
  });

  describe("派发降级", () => {
    it("显式 deepseek 但响应是 OpenAI 标准 → fall through 到嗅探链命中 OpenAI 标准", () => {
      // 运维边缘场景: preset 声明 deepseek 但实际请求被路由到非 DeepSeek 上游
      // 仍能拿到 OpenAI 标准的 cache 信息,不丢观测
      const usage = parseOpenAICompatibleUsage(
        {
          prompt_tokens: 1200,
          completion_tokens: 300,
          prompt_tokens_details: { cached_tokens: 800 },
        },
        "deepseek",
      );

      expect(usage.cacheReadTokens).toBe(800);
    });

    it("所有 parser 都不识别 → base fallback 仅保 prompt/completion", () => {
      // 假想 vendor 用了完全私有的字段名 —— 至少 base 字段还能解析
      const usage = parseOpenAICompatibleUsage({
        prompt_tokens: 100,
        completion_tokens: 50,
        weird_vendor_cache_field: 80,
      });

      expect(usage.inputTokens).toBe(100);
      expect(usage.outputTokens).toBe(50);
      expect(usage.cacheReadTokens).toBeUndefined();
    });

    it("连 prompt_tokens 都没有 → 全 0(不丢观测,不抛错)", () => {
      const usage = parseOpenAICompatibleUsage({});

      expect(usage.inputTokens).toBe(0);
      expect(usage.outputTokens).toBe(0);
      expect(usage.cacheReadTokens).toBeUndefined();
    });
  });

  describe("异常输入健壮性", () => {
    it("null 输入 → 全 0,不抛错", () => {
      const usage = parseOpenAICompatibleUsage(null);

      expect(usage.inputTokens).toBe(0);
      expect(usage.outputTokens).toBe(0);
    });

    it("undefined 输入 → 全 0", () => {
      const usage = parseOpenAICompatibleUsage(undefined);

      expect(usage.inputTokens).toBe(0);
      expect(usage.outputTokens).toBe(0);
    });

    it("非对象输入(字符串/数字) → 全 0", () => {
      expect(parseOpenAICompatibleUsage("not-an-object")).toEqual({
        inputTokens: 0,
        outputTokens: 0,
      });
      expect(parseOpenAICompatibleUsage(42)).toEqual({
        inputTokens: 0,
        outputTokens: 0,
      });
    });

    it("字段类型错误(应该是 number 但是字符串)→ 视为缺失,不抛错", () => {
      const usage = parseOpenAICompatibleUsage({
        prompt_tokens: "not-a-number",
        completion_tokens: 50,
      });

      // prompt_tokens 不是数字 → DeepSeek/OpenAI 标准都无法识别 → base fallback 跳过此字段
      expect(usage.inputTokens).toBe(0);
      expect(usage.outputTokens).toBe(50);
    });

    it("prompt_tokens_details 不是对象时不抛错,只是不解析 cache", () => {
      const usage = parseOpenAICompatibleUsage(
        {
          prompt_tokens: 100,
          completion_tokens: 50,
          prompt_tokens_details: "malformed",
        },
        "openai-standard",
      );

      expect(usage.inputTokens).toBe(100);
      expect(usage.cacheReadTokens).toBeUndefined();
    });
  });
});
