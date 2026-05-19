/**
 * UI 暴露的 provider 子集——CLI 各 UI 入口共享。
 *
 * 与 `@zhixing/providers` 的 PROVIDER_PRESETS 区分：
 *   - PROVIDER_PRESETS：协议层全集。所有可解析的 provider（含未来未上线的）。
 *   - 此 registry：UI 层白名单。当前曝光给用户选择的子集。
 *
 * 当前曝光：硅基流动 / DeepSeek 官方——其它已 preset 但暂不 UI 化的 provider 不在此处。
 *
 * 增加 provider 流程：
 *   1. 这里加一项（label + id + 描述 + 文档链接）
 *   2. 确保 `packages/providers/src/presets.ts` 有对应 preset（baseUrl / protocol / quirks）
 *   3. `credentials.json` 模板加该 provider 占位（packages/providers/src/credentials-loader.ts）
 *
 * 文档链接以 `docUrl` / `modelListDocUrl` 显式声明（first-class 字段）——让
 * input panel 渲染为可点击行（OSC 8），不靠 regex 解析。链接尽量指向**用户
 * 真正要去的具体页面**（API Key 创建页 / 模型列表页），而非产品主页——
 * 首次用户摸索成本可降一个数量级。
 */

export interface SupportedProvider {
  id: string;
  /** UI 显示名 */
  label: string;
  /** 短描述（可选），显示在选择列表的右侧 */
  description?: string;
  /** API Key 编辑面板的提示文本（不含 URL，URL 走 docUrl） */
  apiKeyHint: string;
  /** API Key 格式示例（如 "sk-xxxxxxxxxxxxxxxx"） */
  apiKeyExample: string;
  /** API Key 创建页文档链接——input panel 渲染为可点击行 */
  docUrl?: string;
  /** 模型列表文档链接——add-model panel 渲染为可点击行，引导用户去查可用 model id */
  modelListDocUrl?: string;
  /** add-model panel 显示的 model id 示例（参考性质，让用户知道格式） */
  modelExample?: string;
}

export const SUPPORTED_PROVIDERS: SupportedProvider[] = [
  {
    id: "siliconflow",
    label: "硅基流动",
    description: "OpenAI 兼容协议 · 国内可用",
    apiKeyHint: "用于调用硅基流动的对话 API。",
    apiKeyExample: "sk-xxxxxxxxxxxxxxxx",
    docUrl: "https://cloud.siliconflow.cn/account/ak",
    modelListDocUrl: "https://cloud.siliconflow.cn/models",
    modelExample: "deepseek-ai/DeepSeek-V4-Flash",
  },
  {
    id: "deepseek",
    label: "DeepSeek 官方",
    description: "OpenAI 兼容协议 · 官方直连",
    apiKeyHint: "用于调用 DeepSeek 官方 API。",
    apiKeyExample: "sk-xxxxxxxxxxxxxxxx",
    docUrl: "https://platform.deepseek.com/api_keys",
    modelListDocUrl: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing",
    modelExample: "deepseek-v4-flash",
  },
];
