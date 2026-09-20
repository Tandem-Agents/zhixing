/**
 * 消息通道 section 定义。
 *
 * L1 主面板的"消息通道"分组——列出当前阶段支持的 channel 类型，每项显示启用状态。
 * 进入后导航到 channel-config 配置该 channel。
 *
 * 字段级 issues 直接复用 `checkMessaging`——**单一规则源**。
 * EntryState 三态：未启用 → disabled；已启用 + 字段齐 → ready；已启用 + 缺字段 → blocked。
 */

import type {
  EntryState,
  Section,
  SectionEntry,
  WorkingState,
} from "../types.js";
import { isMessagingEnabled, messagingEnabledProjection } from "../state.js";
import { listSupportedChannels, findSupportedChannel } from "../../registries/index.js";
import { checkMessaging, type MessagingIssue } from "../checks/messaging.js";

export const messagingSection: Section = {
  id: "messaging",
  title: "消息通道",
  description: "用于接收外部消息触发 agent（如飞书）",
  entries: (state) => {
    const catalog = state.channelCatalog ?? listSupportedChannels();
    const allIssues = checkMessaging(state.config, { channels: state.credentials.channels }, messagingEnabledProjection(state), catalog);
    const ids = [...new Set([...listSupportedChannels().map((channel) => channel.id), ...Object.keys(state.config.messaging ?? {}), ...Object.keys(state.channelStates ?? {})])];
    return ids.map((id) => {
      const definition = findSupportedChannel(catalog, id, state.config.messaging?.[id]?.type ?? state.channelStates?.[id]?.type);
      return buildEntry(state, id, definition?.id === id ? definition.label : `${definition?.label ?? "连接"} · ${id}`, allIssues);
    });
  },
};

function buildEntry(
  state: WorkingState,
  channelId: string,
  label: string,
  allIssues: MessagingIssue[],
): SectionEntry {
  const enabled = isMessagingEnabled(state, channelId);
  const myIssues = allIssues.filter((i) => i.channelId === channelId);

  return {
    label,
    state: myIssues.length === 0 && state.channelStates?.[channelId]?.configurationIssue
      ? { kind: "ready", statusText: `${enabled ? "已启用" : "未启用"} · 配置待应用` }
      : buildEntryState(enabled, myIssues),
    enterTarget: { kind: "channel-config", channelId },
  };
}

/**
 * 把 (enabled, issues) 折叠成 EntryState 三态。
 *
 * 命名约定 + 为何"故意不抽公共"详见 entry.ts 顶部文档。
 */
function buildEntryState(
  enabled: boolean,
  myIssues: MessagingIssue[],
): EntryState {
  // 未启用——disabled；issues 必为空（checkMessaging 只查已启用 channel）
  if (!enabled) {
    return { kind: "disabled", statusText: "未启用" };
  }
  if (myIssues.length === 0) {
    return { kind: "ready", statusText: "已启用" };
  }
  return {
    kind: "blocked",
    statusText: "已启用（待补充凭证字段）",
    issues: myIssues.map((i) => i.label),
  };
}
