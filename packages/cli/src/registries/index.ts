/**
 * UI Registry 共享层——CLI 内多个 UI 入口共用的统一派生视图。
 *
 * 为什么独立成层（不放在 config-editor 内）：
 *   - 语义是全产品 UI 消费的预设/通道/MCP 视图，不是 config-editor 私有概念
 *   - `/config` 与 `/model` 等终端入口共同消费同一单一策展目录派生视图（`listSupportedProviders`）
 *
 * 任何 caller 想要获取当前 UI 支持的 provider / channel / MCP 预设，从此 index 一站式 import。
 */

export {
  SUPPORTED_PROVIDERS,
  listSupportedProviders,
  type SupportedProvider,
} from "./providers.js";
export {
  listSupportedChannels,
  findSupportedChannel,
  type SupportedChannel,
  type ChannelFieldSpec,
} from "./channels.js";
export {
  MCP_PRESETS,
  findMcpPreset,
  applyMcpPreset,
  applyMcpSecretFields,
  type McpPreset,
  type McpSecretFieldSpec,
} from "@zhixing-ai/core/mcp-management";
