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
import type { McpConfig, ZhixingCredentials } from "@zhixing/providers";

/**
 * config.mcp（决策层）+ credentials.mcp（内容层）→ 连接规格。
 *
 * 凭证按 server 的 transport 注入：http → 请求头（如 Authorization）、stdio → 环境
 * 变量。当前阶段直接把 credentials.mcp.<id> 的字段作为 header / env 键值对（用户 / 接入
 * 引导填写正确的 key），系统不解释字段语义。
 */
export function parseServerSpecs(
  mcp: McpConfig | undefined,
  credentials?: ZhixingCredentials["mcp"],
): McpServerSpec[] {
  const servers = mcp?.servers;
  if (!servers) return [];

  const specs: McpServerSpec[] = [];
  for (const [serverId, entry] of Object.entries(servers)) {
    if (entry.enabled === false) continue;
    if (!isValidServerId(serverId)) continue;

    const transport = entry.type ?? "stdio";
    const spec: McpServerSpec = { serverId, transport };
    if (entry.command !== undefined) spec.command = entry.command;
    if (entry.args !== undefined) spec.args = entry.args;
    if (entry.url !== undefined) spec.url = entry.url;

    const cred = credentials?.[serverId];
    if (cred && Object.keys(cred).length > 0) {
      if (transport === "http") {
        spec.headers = cred;
      } else {
        spec.env = cred;
      }
    }

    specs.push(spec);
  }
  return specs;
}
