/**
 * 消息通道基础配置缺失检测——纯函数。**单一规则源**。
 *
 * 「必要字段」= 启用某 channel 时（出现在 config.messaging）该 channel 的所有
 * 必填凭证字段非空。字段定义读取自 SUPPORTED_CHANNELS——避免与 registries
 * 层双源漂移（之前 checks 自带 REQUIRED_FIELDS_BY_CHANNEL 表与 registry 重复）。
 *
 * 未启用任何 channel 时（messaging 空）→ 不视为缺失（用户不需要 channel 也能跑 server，
 * 虽然 server 没 channel 实用价值有限，但不强制）。
 *
 * 输出 `MessagingIssue[]` 同时服务 boot + editor 两类 caller。
 */

import type { ZhixingConfig, ZhixingCredentials } from "@zhixing/providers";
import { SUPPORTED_CHANNELS } from "../../registries/index.js";

export interface MessagingIssue {
  channelId: string;
  field: string;
  path: string;
  /** 完整人类可读（"飞书 - App ID"，用于 boot 提示 / main panel 错误） */
  label: string;
  /** 简短字段名（"App ID"，用于 entity 按钮短消息） */
  fieldLabel: string;
}

/**
 * 检测 messaging 必要字段缺失。仅检查已启用的 channel（在 config.messaging 中存在）。
 */
export function checkMessaging(
  config: ZhixingConfig,
  credentials: ZhixingCredentials,
): MessagingIssue[] {
  const issues: MessagingIssue[] = [];
  const messaging = config.messaging ?? {};

  for (const channelId of Object.keys(messaging)) {
    const channelDef = SUPPORTED_CHANNELS.find((c) => c.id === channelId);
    if (!channelDef) continue;

    const channelCreds = credentials.channels?.[channelId] ?? {};
    for (const field of channelDef.requiredFields) {
      if (!channelCreds[field.id]) {
        issues.push({
          channelId,
          field: field.id,
          path: `credentials.channels.${channelId}.${field.id}`,
          label: `${channelDef.label} - ${field.label}`,
          fieldLabel: field.label,
        });
      }
    }
  }

  return issues;
}
