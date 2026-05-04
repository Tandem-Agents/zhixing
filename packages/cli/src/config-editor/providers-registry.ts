/**
 * 配置编辑器支持的 provider 列表（渐进式扩展点）。
 *
 * 当前阶段仅支持硅基流动。新增 provider 时：
 *   1. 这里加一项（label + id + 描述 + 文档链接）
 *   2. 确保 packages/providers/src/presets.ts 有对应预设（baseUrl / protocol / defaultModel）
 *   3. credentials.json 模板加该 provider 的占位（packages/providers/src/credentials-loader.ts）
 *
 * 与 PROVIDER_PRESETS 解耦的原因：preset 是协议解析层面的全部支持（含未来可能 provider），
 * 这里是 wizard UI 暴露给用户选择的子集——避免一次性把 8 家都摆出来淹没用户。
 *
 * 文档链接以 `docUrl` / `modelListDocUrl` 显式声明（first-class 字段）——让 input panel
 * 单独渲染为可点击文档行（OSC 8），不靠 regex 解析 hint。链接尽量指向**用户真正要去
 * 的具体页面**（API Key 创建页 / 模型列表页），而非产品主页——首次用户摸索成本可降
 * 一个数量级。
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
    modelExample: "deepseek-ai/DeepSeek-V3",
  },
];
