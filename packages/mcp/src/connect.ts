/**
 * 建链原语 —— 造 transport → connect → 首次 tools/list。
 *
 * 常驻连接（hub）与一次性探测（probe）共用同一套安全连接路径（同一个 createTransport：
 * SSRF-safe fetch / env 白名单），避免出现第二条连接旁路而安全策略漂移。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { NetworkPolicy } from "@zhixing/network";
import type {
  CreatedTransport,
  CreateTransportOptions,
} from "./transport.js";
import type { McpServerSpec, McpToolDescriptor } from "./types.js";

/** 知行作为 MCP client 向 server 申报的身份。 */
export const CLIENT_INFO = { name: "zhixing", version: "0.1.0" };

/** transport 构造函数签名 —— 默认按 spec 造真实 transport，测试可注入内存传输。 */
export type CreateTransportFn = (
  spec: McpServerSpec,
  options: CreateTransportOptions,
) => CreatedTransport;

/** 一次成功建链的产物 —— 调用方决定保留（hub）还是立即关闭（probe）。 */
export interface ConnectedClient {
  client: Client;
  tools: McpToolDescriptor[];
  /** 释放 transport 的额外资源（http 连接池）；stdio 为空。 */
  disposeTransport?: () => Promise<void>;
}

/**
 * 造 transport → connect → 首次 tools/list。成功返回产物（client 仍连着）；失败先释放
 * 已创建的 transport 资源（kill 已 spawn 的 stdio 子进程 / 关 http 连接池）再抛。
 */
export async function connectAndListTools(
  spec: McpServerSpec,
  opts: {
    createTransport: CreateTransportFn;
    proxy?: NetworkPolicy["proxy"];
    timeoutMs: number;
    /** 中断信号 —— abort 时连接 / 列工具立即失败，建链资源随 catch 释放（一次性探测的取消用）。 */
    signal?: AbortSignal;
  },
): Promise<ConnectedClient> {
  let created: CreatedTransport | undefined;
  try {
    created = opts.createTransport(spec, { proxy: opts.proxy });
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    const reqOptions = { timeout: opts.timeoutMs, signal: opts.signal };
    await client.connect(created.transport, reqOptions);
    const listed = await client.listTools({}, reqOptions);
    return {
      client,
      tools: listed.tools.map(toDescriptor),
      disposeTransport: created.dispose,
    };
  } catch (err) {
    if (created) {
      await created.transport.close().catch(() => {});
      await created.dispose?.().catch(() => {});
    }
    throw err;
  }
}

/** SDK 的 tool 描述 → 知行中性 McpToolDescriptor（只取映射层需要的字段）。 */
export function toDescriptor(tool: {
  name: string;
  description?: string;
  inputSchema: unknown;
  annotations?: { readOnlyHint?: boolean };
}): McpToolDescriptor {
  const descriptor: McpToolDescriptor = {
    name: tool.name,
    inputSchema: tool.inputSchema,
  };
  if (typeof tool.description === "string") {
    descriptor.description = tool.description;
  }
  if (typeof tool.annotations?.readOnlyHint === "boolean") {
    descriptor.readOnlyHint = tool.annotations.readOnlyHint;
  }
  return descriptor;
}
