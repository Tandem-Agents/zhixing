/**
 * UI 暴露的 channel（消息通道）子集——CLI 各 UI 入口共享。
 *
 * 与 packages/messaging 包的 channel adapter 实现解耦：
 *   - adapter 实现：协议适配层（@zhixing/channel-feishu 等），全集
 *   - 此 registry：UI 层白名单，当前曝光给用户选择的子集
 *
 * 字段层级与 channel adapter 期望对齐——adapter 通过 `ChannelConfig.credentials`
 * 读这些 key（key 名要严格一致）。
 *
 * 增加 channel 流程：
 *   1. 这里加一项（label + id + 必填字段）
 *   2. 确保 channel adapter 实现存在（如 @zhixing/channel-feishu）
 *   3. `credentials.json` 模板加该 channel 占位（packages/providers/src/credentials-loader.ts）
 *
 * 文档链接以 `docUrl` 显式声明在每个 field 上（first-class 字段，不内嵌 hint
 * 文本）——让 input panel 单独渲染为可点击文档行，不靠 regex 解析。
 */

export interface ChannelFieldSpec {
  id: string;
  label: string;
  hint: string;
  example: string;
  sensitive: boolean;
  /** 文档链接——input panel 单独渲染为可点击行（OSC 8 hyperlink） */
  docUrl?: string;
}

export interface SupportedChannel {
  id: string;
  /** UI 显示名 */
  label: string;
  /** 短描述（可选），显示在选择列表的右侧 */
  description?: string;
  /** 必填字段列表 */
  requiredFields: ChannelFieldSpec[];
}

export const SUPPORTED_CHANNELS: SupportedChannel[] = [
  {
    id: "feishu",
    label: "飞书",
    description: "企业 IM 通道",
    requiredFields: [
      {
        id: "appId",
        label: "App ID",
        hint: "飞书开放平台应用的 App ID（公开标识）。",
        example: "cli_xxxxxxxxxxxx",
        sensitive: false,
        docUrl: "https://open.feishu.cn/app",
      },
      {
        id: "appSecret",
        label: "App Secret",
        hint: "飞书开放平台应用的 App Secret（私密凭证）。",
        example: "xxxxxxxxxxxxxxxxxxxxxxxx",
        sensitive: true,
        docUrl: "https://open.feishu.cn/app",
      },
    ],
  },
];
