/**
 * 消息通道基础配置缺失检测——纯函数。
 *
 * 「必要字段」= 启用某 channel 时（出现在 config.messaging）该 channel 的凭证字段非空：
 *   - feishu：appId + appSecret 都必须填
 *
 * 未启用任何 channel 时（messaging 空）→ 不视为缺失（用户不需要 channel 也能跑 server，
 *   虽然 server 没 channel 实用价值有限，但不强制）。
 */

import type { ZhixingConfig, ZhixingCredentials } from "@zhixing/providers";

export interface BootMessagingMissing {
  channelId: string;
  field: string;
  label: string;
}

/**
 * 检测 server 模式下 messaging 必要字段缺失。
 *
 * 只检查已启用的 channel——未启用（不在 config.messaging 中）不查。
 */
export function checkBootMessaging(
  config: ZhixingConfig,
  credentials: ZhixingCredentials,
): BootMessagingMissing[] {
  const missing: BootMessagingMissing[] = [];
  const messaging = config.messaging ?? {};

  for (const channelId of Object.keys(messaging)) {
    const requiredFields = REQUIRED_FIELDS_BY_CHANNEL[channelId];
    if (!requiredFields) continue;

    const channelCreds = credentials.channels?.[channelId] ?? {};
    for (const field of requiredFields) {
      if (!channelCreds[field.id]) {
        missing.push({
          channelId,
          field: field.id,
          label: `${field.channelLabel} - ${field.fieldLabel}`,
        });
      }
    }
  }

  return missing;
}

interface ChannelRequiredField {
  id: string;
  channelLabel: string;
  fieldLabel: string;
}

/**
 * 内置 channel 的必填字段定义。
 *
 * 渐进式扩展：未来加新 channel 在此注册即可。
 */
const REQUIRED_FIELDS_BY_CHANNEL: Record<string, ChannelRequiredField[]> = {
  feishu: [
    { id: "appId", channelLabel: "飞书", fieldLabel: "App ID" },
    { id: "appSecret", channelLabel: "飞书", fieldLabel: "App Secret" },
  ],
};
