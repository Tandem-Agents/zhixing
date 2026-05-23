/**
 * MCP transport 构造 —— 把"按 server 规格造出 SDK transport"这一关注点隔离在此。
 * hub 只依赖本模块的 createTransport；新增传输方式时只动这里、hub 不变。
 */

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerSpec } from "./types.js";

export function createTransport(spec: McpServerSpec): Transport {
  if (spec.transport === "stdio") {
    if (!spec.command) {
      throw new Error(
        `MCP server "${spec.serverId}" 声明为 stdio 但未提供 command`,
      );
    }
    return new StdioClientTransport({
      command: spec.command,
      args: spec.args ?? [],
      // 不传 env：SDK 默认用 getDefaultEnvironment() 的安全白名单（只继承
      // PATH / HOME 等已知安全变量），天然挡掉 NODE_OPTIONS / LD_PRELOAD / DYLD_*
      // 等解释器注入面。需要叠加 server 专属 env / 凭证时，应显式与
      // getDefaultEnvironment() 合并，而非继承整个 process.env。
    });
  }

  throw new Error(
    `MCP server "${spec.serverId}" 的传输方式 "${spec.transport}" 暂不支持`,
  );
}
