/**
 * 内置 Provider 预设注册表
 *
 * 新增 OpenAI 兼容服务商只需在这里加一条记录，零代码。
 * 用户使用时只需配置 apiKey，其余字段自动从预设填充。
 */

import type { ProviderPreset } from "./types.js";

/**
 * Provider 预设表。
 *
 * 用 `satisfies Record<string, ProviderPreset>` 而非 `:` 类型标注，让 TS 在
 * 形状校验通过的同时保留具体 key 的字面类型（`keyof typeof PROVIDER_PRESETS`
 * 拿到 `"deepseek" | "minimax" | ...` 而不是 `string`）。档位推荐的
 * `RoleRecommendation.provider` 据此获得编译期"必须是已注册 provider id"的
 * 强约束，杜绝推荐指向一个根本连不上（无 baseUrl/protocol）的 provider。
 */
export const PROVIDER_PRESETS = {
  deepseek: {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    protocol: "openai-compatible",
    knownModels: [
      // 推荐默认 —— 支持思考模式（默认开），适合复杂推理 / 编码 / 多步规划 /
      // agent 任务；输入 3元/M、输出 6元/M。
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        contextWindow: 1_000_000,
        maxOutputTokens: 384_000,
        supportsTools: true,
        supportsThinking: true,
        // 官方思考档：effort high(默认)/ max；off 关闭。low/med→high、
        // xhigh→max 的兼容映射由 adapter 思考方言处理，不入用户可配档位。
        thinkingControl: { type: "effort", efforts: ["high", "max"], default: "high" },
      },
      // 轻量版 —— 工具调用 / agent 任务，性价比高（输入 1元/M、输出 2元/M），
      // 约 v4-pro 的 1/3 价格；不支持思考模式。
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        contextWindow: 1_000_000,
        maxOutputTokens: 384_000,
        supportsTools: true,
      },
    ],
    quirks: {
      supportsTools: true,
      supportsStreamUsage: true,
      // DeepSeek 旗下至少 deepseek-v4-pro 支持 thinking 模式,粗粒度声明用于
      // UI 标记;细粒度按 model 维度看 knownModels[*].supportsThinking。运行时
      // 透传 reasoning_content 不依赖此字段(协议级处理,字段缺失自然 no-op)。
      supportsThinking: true,
      // DeepSeek 用自有 usage 方言 prompt_cache_hit_tokens / prompt_cache_miss_tokens
      // (非 OpenAI 标准 prompt_tokens_details.cached_tokens),显式声明走最短解析路径
      usageDialect: "deepseek",
      thinkingDialect: "deepseek",
    },
  },

  minimax: {
    name: "MiniMax",
    baseUrl: "https://api.minimax.chat/v1",
    protocol: "openai-compatible",
    quirks: {
      supportsTools: true,
    },
  },

  siliconflow: {
    name: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    protocol: "openai-compatible",
    knownModels: [
      // 推荐默认 —— 工具调用 / agent 任务实测协议遵循度好。
      {
        id: "deepseek-ai/DeepSeek-V4-Flash",
        name: "DeepSeek V4 Flash",
        contextWindow: 1_000_000,
        maxOutputTokens: 384_000,
        supportsTools: true,
      },
      {
        id: "Pro/MiniMaxAI/MiniMax-M2.5",
        name: "MiniMax M2.5 Pro",
        contextWindow: 1_000_000,
        maxOutputTokens: 384_000,
        supportsTools: true,
      },
    ],
    quirks: {
      supportsTools: true,
      supportsStreamUsage: true,
      // **不显式声明 usageDialect** —— 嗅探链自动 fallback：
      //
      // 硅基流动作为中转平台不透传上游 LLM 的 prompt cache 命中字段(实测 2026-05
      // DeepSeek-V4-Flash via 硅基流动: 响应 usage 仅含 prompt_tokens /
      // completion_tokens, 无 prompt_cache_hit_tokens 也无 prompt_tokens_details.
      // cached_tokens, 无论上下文复用程度如何), 因此 CLI `--ctx` 指示器的
      // `(cache Xk)` 后缀在此 provider 下**永远不显示** —— 这是上游限制, 非 zhixing
      // 实现 bug。
      //
      // 历史推断: 中转平台按 token 计费, 暴露 cache 命中可能影响计费可见性 ——
      // 是商业决策而非技术限制。需要看 cache 时换 DeepSeek 直连 (api.deepseek.com)
      // 或其他暴露 cache 字段的 vendor (anthropic / openai)。
    },
  },

  qwen: {
    name: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    protocol: "openai-compatible",
    quirks: {
      supportsTools: true,
      supportsStreamUsage: true,
    },
  },

  kimi: {
    name: "Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    protocol: "openai-compatible",
    quirks: {
      supportsTools: true,
    },
  },

  glm: {
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    protocol: "openai-compatible",
    quirks: {
      supportsTools: true,
    },
  },

  openai: {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    protocol: "openai-compatible",
    quirks: {
      maxTokensField: "max_completion_tokens",
      supportsTools: true,
      supportsStreamUsage: true,
    },
  },

  anthropic: {
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    protocol: "anthropic-messages",
    quirks: {
      // Claude extended thinking 发送侧 + signature multi-turn replay 已接入
      // (anthropic adapter 按 ChatRequest.thinking 发 thinking{type,budget_tokens},
      // 入站累积 signature_delta、出站原样回传)。供 UI 粗标。逐 Claude 模型的
      // ThinkingControl 档位枚举(opus/sonnet 各代 budget 范围差异)属 model
      // catalog 数据填充,按模型补查官方后填 knownModels。
      supportsThinking: true,
      supportsTools: true,
      supportsStreamUsage: true,
      thinkingDialect: "anthropic",
    },
  },
} satisfies Record<string, ProviderPreset>;

/**
 * 获取预设。返回 undefined 表示不在预设列表中（自定义 provider）。
 *
 * PROVIDER_PRESETS 用 `satisfies` 保留了字面 key 类型（让档位推荐的
 * `RoleRecommendation.provider` 拿到精确的 provider id union 做编译期约束），
 * 代价是任意 string 索引访问的 TS 推断变严；用
 * `Record<string, ProviderPreset | undefined>` 视图把"任意 id 可能不存在"的
 * 运行时语义还原到类型层，避免在调用点用断言糊弄。
 */
export function getPreset(providerId: string): ProviderPreset | undefined {
  return (PROVIDER_PRESETS as Record<string, ProviderPreset | undefined>)[
    providerId
  ];
}

/**
 * 获取所有预设 ID 列表。
 */
export function getPresetIds(): string[] {
  return Object.keys(PROVIDER_PRESETS);
}
