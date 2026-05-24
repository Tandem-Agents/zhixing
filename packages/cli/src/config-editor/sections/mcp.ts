/**
 * MCP 服务 section 定义。
 *
 * L1 主面板的"MCP 服务"分组——列出 config 中**全部**已接入 server（含已停用），按 serverId
 * 叠加 hub 运行时状态（连接 / 连接中 + 工具数）。进入后到 mcp-server 面板做启停 / 删除。
 *
 * 列表来源是 `config.mcp`（含停用 server），**不是** serverStatuses（后者只含受管的启用
 * server，停用的不在其中、用作列表来源会让用户无法重新启用）。运行态仅作叠加。
 *
 * MCP server 的"连接中"是运行时状态、不是配置缺失，故一律不产 blocked issues——否则会
 * 错误阻塞编辑器的"完成"（保存配置不应被某个 server 正在重连卡住）。
 */

import type {
  EntryState,
  Section,
  SectionEntry,
  WorkingState,
} from "../types.js";
import type { McpServerStatus } from "@zhixing/mcp";
import { isMcpServerEnabled, listMcpServerIds } from "../state.js";
import { MCP_PRESETS } from "../../registries/index.js";

export const mcpSection: Section = {
  id: "mcp",
  title: "MCP 服务",
  description: "接入外部 MCP server，把其工具加入 agent 工具集",
  // 纯可选：接不接 server 都不阻塞完成；主面板据此不显示"全部就绪"裁决。
  optional: true,
  entries: (state, runtime) => {
    const statusById = new Map(
      (runtime?.mcpServerStatuses?.() ?? []).map((s) => [s.serverId, s] as const),
    );
    const ids = listMcpServerIds(state);
    const servers = ids.map((serverId) =>
      buildEntry(state, serverId, statusById.get(serverId)),
    );
    // 未接入的预设列为"添加 X"入口——已接入的不重复列（按 server id 判定）
    const installed = new Set(ids);
    const additions = MCP_PRESETS.filter((p) => !installed.has(p.id)).map(
      (preset): SectionEntry => ({
        label: `添加 ${preset.label}`,
        state: { kind: "disabled", statusText: "未接入" },
        enterTarget: { kind: "mcp-add", presetId: preset.id },
      }),
    );
    return [...servers, ...additions];
  },
};

function buildEntry(
  state: WorkingState,
  serverId: string,
  status: McpServerStatus | undefined,
): SectionEntry {
  return {
    label: serverId,
    state: buildEntryState(isMcpServerEnabled(state, serverId), status),
    enterTarget: { kind: "mcp-server", serverId },
  };
}

/**
 * 折叠成 EntryState：停用→disabled；启用→ready（连接中也归 ready，靠 statusText 区分，
 * 绝不 blocked——运行时连接状态不阻塞"完成"）。
 */
function buildEntryState(
  enabled: boolean,
  status: McpServerStatus | undefined,
): EntryState {
  if (!enabled) {
    return { kind: "disabled", statusText: "已停用" };
  }
  if (!status) {
    // 已启用但无运行态（无 hub 注入，或连接尚未落定）
    return { kind: "ready", statusText: "已启用" };
  }
  if (status.status === "connected") {
    return { kind: "ready", statusText: `已连接 · ${status.toolCount} 工具` };
  }
  // connecting —— 后台退避重试中；带上最近一次失败原因（若有）
  return {
    kind: "ready",
    statusText: status.error ? `连接中 · ${status.error}` : "连接中",
  };
}
