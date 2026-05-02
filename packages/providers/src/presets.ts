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
    defaultModel: "deepseek-chat",
    quirks: {
      supportsTools: true,
      supportsStreamUsage: true,
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
    quirks: {
      supportsTools: true,
      supportsStreamUsage: true,
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
