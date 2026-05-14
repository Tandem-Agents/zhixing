/**
 * 内置 Provider 预设注册表
 *
 * 新增 OpenAI 兼容服务商只需在这里加一条记录，零代码。
 * 用户使用时只需配置 apiKey，其余字段自动从预设填充。
 */

import type { ProviderPreset } from "./types.js";

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  deepseek: {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    protocol: "openai-compatible",
    defaultModel: "deepseek-v4-flash",
    knownModels: [
      // 推荐默认 —— 工具调用 / agent 任务，性价比高（输入 1元/M、输出 2元/M）。
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        contextWindow: 1_000_000,
        maxOutputTokens: 384_000,
        supportsTools: true,
      },
      // 进阶版 —— 支持思考模式（默认开），适合复杂推理 / 编码 / 多步规划；
      // 输入 3元/M、输出 6元/M，约 v4-flash 的 3 倍。
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        contextWindow: 1_000_000,
        maxOutputTokens: 384_000,
        supportsTools: true,
        supportsThinking: true,
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
    defaultModel: "deepseek-ai/DeepSeek-V4-Flash",
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
    defaultModel: "qwen-plus",
    quirks: {
      supportsTools: true,
      supportsStreamUsage: true,
    },
  },

  kimi: {
    name: "Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    protocol: "openai-compatible",
    defaultModel: "moonshot-v1-auto",
    quirks: {
      supportsTools: true,
    },
  },

  glm: {
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    protocol: "openai-compatible",
    defaultModel: "glm-4-plus",
    quirks: {
      supportsTools: true,
    },
  },

  openai: {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    protocol: "openai-compatible",
    defaultModel: "gpt-4o",
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
    defaultModel: "claude-sonnet-4-20250514",
    quirks: {
      supportsThinking: true,
      supportsTools: true,
      supportsStreamUsage: true,
    },
  },
};

/**
 * 获取预设。返回 undefined 表示不在预设列表中（自定义 provider）。
 */
export function getPreset(providerId: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS[providerId];
}

/**
 * 获取所有预设 ID 列表。
 */
export function getPresetIds(): string[] {
  return Object.keys(PROVIDER_PRESETS);
}
