/**
 * config.mcp → McpServerSpec[] 的装配层桥接。
 *
 * 配置 schema 归 providers、MCP 连接能力归 @zhixing/mcp，二者由装配层（cli）桥接 ——
 * 与 setupChannels 读 config.messaging 装配 channel 实例同款分工，能力包不反向依赖
 * 配置层。
 *
 * 跳过两类 server：显式 enabled:false（用户停用）、serverId 不合法（含 `__` 等会破坏
 * `mcp__<server>__<tool>` 三段解析的字符）—— 后者从源头挡掉命名错位（fail-safe）。
 */

import { isValidServerId, type McpServerSpec } from "@zhixing/mcp";
import type { McpConfig } from "@zhixing/providers";

export function parseServerSpecs(mcp: McpConfig | undefined): McpServerSpec[] {
  const servers = mcp?.servers;
  if (!servers) return [];

  const specs: McpServerSpec[] = [];
  for (const [serverId, entry] of Object.entries(servers)) {
    if (entry.enabled === false) continue;
    if (!isValidServerId(serverId)) continue;

    const spec: McpServerSpec = {
      serverId,
      transport: entry.type ?? "stdio",
    };
    if (entry.command !== undefined) spec.command = entry.command;
    if (entry.args !== undefined) spec.args = entry.args;
    if (entry.url !== undefined) spec.url = entry.url;
    specs.push(spec);
  }
  return specs;
}
