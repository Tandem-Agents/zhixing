/**
 * UI Registry 共享层——CLI 内多个 UI 入口共用的"产品白名单"。
 *
 * 为什么独立成层（不放在 config-editor 内）：
 *   - 语义是"全产品 UI 暴露子集"，不是 config-editor 私有概念
 *   - REPL 工作台未来的 `/model` 切换、`/messaging` 列表等也会消费同一份名单
 *   - 与 `@zhixing/providers` 的 PROVIDER_PRESETS（协议层全集）正交：
 *     此处控制"曝光给用户的节奏"，那里维护"协议解析能力"
 *
 * 任何 caller 想要"当前 UI 支持哪些 provider / channel"，从此 index 一站式 import。
 */

export {
  SUPPORTED_PROVIDERS,
  type SupportedProvider,
} from "./providers.js";
export {
  SUPPORTED_CHANNELS,
  type SupportedChannel,
  type ChannelFieldSpec,
} from "./channels.js";
