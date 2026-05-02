/**
 * 消息通道 section 定义。
 *
 * L1 主面板的"消息通道"分组——列出当前阶段支持的 channel 类型，每项显示启用状态。
 * 进入后导航到 channel-config 配置该 channel。
 */

import type { Section, SectionEntry, WorkingState } from "../types.js";
import { isMessagingEnabled, readChannelEntry } from "../state.js";
import { SUPPORTED_CHANNELS } from "../channels-registry.js";

export const messagingSection: Section = {
  id: "messaging",
  title: "消息通道（启用以接收外部消息）",
  entries: (state) => SUPPORTED_CHANNELS.map((channel) => buildEntry(state, channel.id, channel.label)),
  validate: (state) => {
    const issues: string[] = [];
    const messaging = state.config.messaging ?? {};
    for (const channelId of Object.keys(messaging)) {
      const channelDef = SUPPORTED_CHANNELS.find((c) => c.id === channelId);
      if (!channelDef) continue;
      const creds = readChannelEntry(state, channelId) ?? {};
      for (const field of channelDef.requiredFields) {
        if (!creds[field.id]) {
          issues.push(`${channelDef.label} - ${field.label} 未填`);
        }
      }
    }
    return issues;
  },
};

function buildEntry(
  state: WorkingState,
  channelId: string,
  label: string,
): SectionEntry {
  const enabled = isMessagingEnabled(state, channelId);
  const creds = readChannelEntry(state, channelId);
  let status: string;
  if (!enabled) {
    status = "未启用";
  } else {
    const channelDef = SUPPORTED_CHANNELS.find((c) => c.id === channelId);
    const allFilled = channelDef?.requiredFields.every((f) => creds?.[f.id]) ?? false;
    status = allFilled ? "已启用" : "已启用（缺凭证字段）";
  }
  return {
    label,
    status,
    enterTarget: { kind: "channel-config", channelId },
  };
}
