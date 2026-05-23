/**
 * MCP transport 构造 —— 把"按 server 规格造出 SDK transport"这一关注点隔离在此。
 * hub 只依赖本模块的 createTransport；新增传输方式时只动这里、hub 不变。
 *
 * 返回 transport + 可选 dispose：http transport 注入的 SSRF-safe fetch 持有 undici
 * 连接池，需在断开时显式释放（dispose）；stdio 无额外资源（子进程由 transport.close kill）。
 */

import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createSafeFetch, type NetworkPolicy } from "@zhixing/network";
import type { McpServerSpec } from "./types.js";

export interface CreateTransportOptions {
  /** 网络代理配置 —— http transport 的 SSRF-safe fetch 据此继承 network.proxy。 */
  proxy?: NetworkPolicy["proxy"];
}

/** transport 及其额外资源清理。 */
export interface CreatedTransport {
  transport: Transport;
  /** 释放额外资源（http 连接池）。stdio 无需（子进程由 transport.close kill）。 */
  dispose?: () => Promise<void>;
}

export function createTransport(
  spec: McpServerSpec,
  options: CreateTransportOptions = {},
): CreatedTransport {
  if (spec.transport === "stdio") {
    if (!spec.command) {
      throw new Error(
        `MCP server "${spec.serverId}" 声明为 stdio 但未提供 command`,
      );
    }
    return {
      transport: new StdioClientTransport({
        command: spec.command,
        args: spec.args ?? [],
        // 无附加 env 时不传：SDK 默认用 getDefaultEnvironment() 安全白名单（只继承
        // PATH / HOME 等，挡掉 NODE_OPTIONS / LD_PRELOAD / DYLD_*）。有 server 专属
        // env / 凭证时，叠加在该白名单基线之上，而非继承整个 process.env。
        ...(spec.env && {
          env: { ...getDefaultEnvironment(), ...spec.env },
        }),
      }),
    };
  }

  if (!spec.url) {
    throw new Error(`MCP server "${spec.serverId}" 声明为 http 但未提供 url`);
  }
  // 出站经 @zhixing/network 的 SSRF-safe fetch（继承 network.proxy + SSRF egress
  // 防护），不走 SDK 默认的全局 fetch。fetch 持有连接池，断开时经 dispose 释放。
  const fetch = createSafeFetch({ proxy: options.proxy });
  const transport = new StreamableHTTPClientTransport(new URL(spec.url), {
    fetch,
    ...(spec.headers && { requestInit: { headers: spec.headers } }),
  });
  return { transport, dispose: () => fetch.close() };
}
