/**
 * 配置编辑器支持的 channel 列表（渐进式扩展点）。
 *
 * 当前阶段仅支持飞书。新增 channel 时：
 *   1. 这里加一项（label + id + 必填字段）
 *   2. 确保 channel adapter 实现存在（如 @zhixing/channel-feishu）
 *   3. credentials.json 模板加该 channel 的占位（packages/providers/src/credentials-loader.ts）
 *
 * 字段层级与 channel adapter 期望对齐——adapter 通过 ChannelConfig.credentials 读这些 key。
 */

export interface ChannelFieldSpec {
  id: string;
  label: string;
  hint: string;
  example: string;
  sensitive: boolean;
}

export interface SupportedChannel {
  id: string;
  /** UI 显示名 */
  label: string;
  /** 必填字段列表 */
  requiredFields: ChannelFieldSpec[];
}

export const SUPPORTED_CHANNELS: SupportedChannel[] = [
  {
    id: "feishu",
    label: "飞书",
    requiredFields: [
      {
        id: "appId",
        label: "App ID",
        hint: "飞书开放平台应用的 App ID（公开标识）。\n在飞书开放平台 https://open.feishu.cn 获取。",
        example: "cli_xxxxxxxxxxxx",
        sensitive: false,
      },
      {
        id: "appSecret",
        label: "App Secret",
        hint: "飞书开放平台应用的 App Secret（私密凭证）。\n在飞书开放平台对应应用页面获取。",
        example: "xxxxxxxxxxxxxxxxxxxxxxxx",
        sensitive: true,
      },
    ],
  },
];
