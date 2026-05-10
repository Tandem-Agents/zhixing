/**
 * OpenAI 兼容协议下 usage 字段的方言归一层
 *
 * 背景:"OpenAI 兼容"是协议层共识(同样的请求 schema / 同样的 SDK),但各 vendor
 * 在响应的 usage 字段上有方言分裂——尤其是 prompt cache 命中信息。本模块把
 * 这种分裂限制在一个文件内,主适配器(openai-compatible.ts)只调一个入口函数。
 *
 * ─── 方言矩阵 ───
 *
 * | Vendor              | Cache 命中字段路径                              |
 * |---------------------|------------------------------------------------|
 * | OpenAI 官方         | usage.prompt_tokens_details.cached_tokens       |
 * | MiniMax(OpenAI形态) | usage.prompt_tokens_details.cached_tokens       |
 * | Kimi/智谱/通义等   | usage.prompt_tokens_details.cached_tokens(假定) |
 * | DeepSeek            | usage.prompt_cache_hit_tokens                   |
 *
 * OpenAI 兼容协议下 vendor 多为服务端自动缓存,只暴露 cache_read,无 cache_write
 * 维度;cacheWriteTokens 在此协议下统一留 undefined。
 *
 * ─── 派发策略 ───
 *
 *   显式 dialect ≠ "auto"  → 直接调对应策略 parser(性能 + 可预测性,推荐 preset 声明)
 *   "auto"/未声明          → 按 AUTO_CHAIN(派生,优先级排序)嗅探,首个命中返回
 *   全部失败               → base fallback(仅 prompt_tokens / completion_tokens)
 *
 * 不抛异常 —— usage 解析失败影响**可观测性**而非**正确性**,优雅降级让 LLM call
 * 继续。base fallback 保证 inputTokens / outputTokens 在任何形态下都能拿到。
 *
 * ─── 扩展点(零认知负担)───
 *
 * 添加新 vendor 方言只需两步,编译期强制,运行时无手动同步成本:
 *
 *   1. 在 ../types.ts 的 UsageDialect 字面量类型加新方言名
 *      → STRATEGIES 的 Record key 类型立即收紧,不补条目编译失败 fail-fast
 *
 *   2. 在本文件 STRATEGIES 加 `<新方言>: { autoDetectionPriority, parse }` 条目
 *      → 嗅探链 AUTO_CHAIN 从 STRATEGIES 派生(filter + sort),自动重新排序
 *      → 显式 dialect 派发自动生效
 *
 * 优先级语义(数字越小越先尝试):
 *   10  — 高特异性方言(字段名独特,先尝试以避免被通用 parser 误吞响应)
 *   100 — 通用兜底(标准 OpenAI 形态,多 vendor 跟随)
 *
 * 不变量: 同一字段格式 = 同一 parser, 不同方言不应有相同 priority
 * (sort 稳定性会让相同 priority 的策略按声明顺序排,易成隐性依赖)。
 *
 * 主适配器(openai-compatible.ts)无需任何改动 —— 这是 Open-Closed 原则的落地。
 */

import type { TokenUsage } from "@zhixing/core";
import type { UsageDialect } from "../types.js";

// ─── Strategy 接口 ───

interface UsageDialectStrategy {
  /**
   * Auto 嗅探优先级 —— 值越小越先尝试。
   *
   * 用数字而非数组下标:让"嗅探顺序"语义内聚在策略声明处,嗅探链自动从此字段
   * 派生(sort by priority),杜绝两份注册表手动同步。
   */
  readonly autoDetectionPriority: number;

  /**
   * Vendor usage 解析。
   *   - 能识别本方言: 返回归一化的 TokenUsage(必含 input/output, 可选含 cache 字段)
   *   - 不能识别(关键 sentinel 字段缺失): 返回 null,触发派发链下游或 fallback
   *
   * cache 字段填法与 anthropic-messages 适配器对齐 —— truthy 检查(>0 才填),
   * 0 与 undefined 视为等价"无明显命中",与 mergeUsage 的合并语义一致。
   */
  parse(raw: Record<string, unknown>): TokenUsage | null;
}

// ─── Parser 实现 ───

/**
 * OpenAI 标准方言。
 *
 * 文档: https://platform.openai.com/docs/guides/prompt-caching
 *   响应包含 usage.prompt_tokens_details.cached_tokens(命中部分),
 *   prompt_tokens 是包含命中的总输入 token 数。
 *
 * 同样适用于 MiniMax(OpenAI 兼容形态)等所有跟随 OpenAI 标准的 vendor。
 *
 * 识别条件: prompt_tokens 必有(数字类型)。这是 OpenAI 协议核心字段,
 * 缺失说明响应不是 OpenAI 标准 usage,返回 null 让派发链尝试其他方言。
 */
const parseOpenAIStandard: UsageDialectStrategy["parse"] = (raw) => {
  const inputTokens = numericField(raw, "prompt_tokens");
  if (inputTokens === null) return null;

  const outputTokens = numericField(raw, "completion_tokens") ?? 0;
  const details = raw.prompt_tokens_details;
  const cached =
    details && typeof details === "object"
      ? numericField(details as Record<string, unknown>, "cached_tokens")
      : null;

  const result: TokenUsage = { inputTokens, outputTokens };
  if (cached !== null && cached > 0) result.cacheReadTokens = cached;
  return result;
};

/**
 * DeepSeek 方言。
 *
 * 文档: https://api-docs.deepseek.com/guides/kv_cache
 *   - prompt_cache_hit_tokens: 命中部分 token 数
 *   - prompt_cache_miss_tokens: 未命中部分 token 数
 *   两者之和等于 prompt_tokens(虽未在文档明示但工程惯例)。
 *
 * DeepSeek 是服务端默认自动缓存,无 cache_write 维度;cacheWriteTokens 不填。
 *
 * 识别条件: prompt_cache_hit_tokens 必有(即使为 0,字段也存在)。这是
 * DeepSeek 独有字段名,无碰撞风险,作为强 sentinel。
 */
const parseDeepSeek: UsageDialectStrategy["parse"] = (raw) => {
  const hit = numericField(raw, "prompt_cache_hit_tokens");
  if (hit === null) return null;

  const inputTokens = numericField(raw, "prompt_tokens") ?? 0;
  const outputTokens = numericField(raw, "completion_tokens") ?? 0;

  const result: TokenUsage = { inputTokens, outputTokens };
  if (hit > 0) result.cacheReadTokens = hit;
  return result;
};

// ─── 单一事实源:策略表 ───

/**
 * Vendor 方言策略表 —— 单一事实源。
 *
 * 不变量(编译期保护): keys 必须与 UsageDialect 字面量(除 "auto")完全对齐。
 * 通过 Record<Exclude<UsageDialect, "auto">, ...> 让 TypeScript 强制要求新加
 * 方言时同步注册条目,否则编译失败 fail-fast。
 *
 * AUTO_CHAIN 由本表派生,**结构上不可能漏同步**。
 */
const STRATEGIES: Record<Exclude<UsageDialect, "auto">, UsageDialectStrategy> = {
  // 高特异性方言:prompt_cache_hit_tokens 字段名独特无碰撞,放嗅探链首位
  deepseek: { autoDetectionPriority: 10, parse: parseDeepSeek },
  // 通用兜底:标准 OpenAI 形态,大多数兼容 vendor 跟随
  "openai-standard": { autoDetectionPriority: 100, parse: parseOpenAIStandard },
};

/**
 * Auto 嗅探链 —— 模块加载时由 STRATEGIES 一次性派生(sort by priority)。
 *
 * 工程意义: 嗅探命中时短路返回,所以高特异性方言先 = 路径最短,
 * 也避免"宽松 parser 误吞特殊方言"(独特字段先 sentinel 检查不被吞掉)。
 */
const AUTO_CHAIN: readonly UsageDialectStrategy[] = [
  ...Object.values(STRATEGIES),
].sort((a, b) => a.autoDetectionPriority - b.autoDetectionPriority);

// ─── Public API ───

/**
 * 解析 OpenAI 兼容协议返回的 usage 对象,归一为 TokenUsage。
 *
 * @param raw OpenAI SDK chunk.usage(typeof unknown,运行时校验)
 * @param dialect 方言提示,默认 "auto" 走嗅探链
 *
 * 返回保证: 任何输入都返回有效 TokenUsage(至少含 inputTokens/outputTokens),
 * 不抛异常。失败路径降级到 base parser,丢失 cache 信息但保 base token 计数。
 */
export function parseOpenAICompatibleUsage(
  raw: unknown,
  dialect: UsageDialect = "auto",
): TokenUsage {
  if (!raw || typeof raw !== "object") {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const usage = raw as Record<string, unknown>;

  // 显式 dialect: 优先调对应策略,失败 fall through 到嗅探链/兜底
  // (容忍"声明了 deepseek 但实际请求被路由到非 DeepSeek 上游"等运维边缘场景)
  if (dialect !== "auto") {
    const result = STRATEGIES[dialect].parse(usage);
    if (result) return result;
  }

  // Auto 嗅探链
  for (const strategy of AUTO_CHAIN) {
    const result = strategy.parse(usage);
    if (result) return result;
  }

  // Base fallback —— 字段都不识别仍要保 base token 计数,丢 cache 信息但不丢观测
  return {
    inputTokens: numericField(usage, "prompt_tokens") ?? 0,
    outputTokens: numericField(usage, "completion_tokens") ?? 0,
  };
}

// ─── 内部辅助 ───

/** 安全取数字字段 —— 仅当字段存在且为 number 才返回,否则 null */
function numericField(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === "number" ? v : null;
}
