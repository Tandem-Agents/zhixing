/**
 * 连接层 McpHub —— 管理所有 MCP server 的连接，对上层只暴露"列工具 / 调工具 / 关闭"。
 *
 * 职责单一、与集成层解耦：hub 只做连接 + 协议（SDK Client），产出中性的工具目录
 * 与一个 McpCallFn；把目录映射成知行 ToolDefinition 是映射层的事，hub 不反向依赖
 * 装配 / cli。
 *
 * 空 server 列表时所有方法天然 no-op（connectAll 空跑、catalog 返回 []、callTool
 * 返回 isError、dispose 空），故 hub 引用恒非空、调用方无需任何判空分支。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { NetworkPolicy } from "@zhixing/network";
import { toToolResult } from "./result.js";
import {
  createTransport as defaultCreateTransport,
  type CreateTransportOptions,
} from "./transport.js";
import type {
  McpCallFn,
  McpServerContext,
  McpServerSpec,
  McpToolDescriptor,
} from "./types.js";

/** 知行作为 MCP client 向 server 申报的身份。 */
const CLIENT_INFO = { name: "zhixing", version: "0.1.0" };
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/** 一个已连接 server 暴露给上层的工具目录。 */
export interface McpServerCatalog {
  server: McpServerContext;
  tools: McpToolDescriptor[];
}

export interface McpHub {
  /** 并发连接所有 server（单 server 失败被隔离、不阻塞其余）。装配前调用一次。 */
  connectAll(): Promise<void>;
  /** 已连接 server 的工具目录（失败 / 未连接的 server 不出现）。 */
  catalog(): McpServerCatalog[];
  /** 调用某 server 的工具；server 不可用返回 isError，abort 时让异常冒泡。 */
  callTool: McpCallFn;
  /** 关闭所有连接 / 子进程。 */
  dispose(): Promise<void>;
}

export interface McpHubOptions {
  /** 单 server 连接 + 首次 tools/list 的超时（毫秒）。 */
  connectTimeoutMs?: number;
  /** 网络代理配置 —— 透传给 http transport 的 SSRF-safe fetch（继承 network.proxy）。 */
  networkProxy?: NetworkPolicy["proxy"];
  /** transport 构造注入点 —— 默认按 spec 造真实 transport，测试可注入内存传输。 */
  createTransport?: (spec: McpServerSpec, options: CreateTransportOptions) => Transport;
}

interface Connection {
  context: McpServerContext;
  client?: Client;
  tools: McpToolDescriptor[];
  status: "connected" | "failed";
  error?: string;
}

export function createMcpHub(
  specs: readonly McpServerSpec[],
  options: McpHubOptions = {},
): McpHub {
  const connectTimeoutMs =
    options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const createTransport = options.createTransport ?? defaultCreateTransport;
  const networkProxy = options.networkProxy;
  const connections = new Map<string, Connection>();

  async function connectOne(spec: McpServerSpec): Promise<void> {
    const context: McpServerContext = {
      serverId: spec.serverId,
      transport: spec.transport,
    };
    try {
      const transport = createTransport(spec, { proxy: networkProxy });
      const client = new Client(CLIENT_INFO, { capabilities: {} });
      await client.connect(transport, { timeout: connectTimeoutMs });
      const listed = await client.listTools({}, { timeout: connectTimeoutMs });
      connections.set(spec.serverId, {
        context,
        client,
        tools: listed.tools.map(toDescriptor),
        status: "connected",
      });
    } catch (err) {
      connections.set(spec.serverId, {
        context,
        tools: [],
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    async connectAll() {
      await Promise.allSettled(specs.map(connectOne));
    },

    catalog() {
      const result: McpServerCatalog[] = [];
      for (const conn of connections.values()) {
        if (conn.status === "connected") {
          result.push({ server: conn.context, tools: conn.tools });
        }
      }
      return result;
    },

    callTool: async (serverId, toolName, input, callOptions) => {
      const conn = connections.get(serverId);
      if (!conn || conn.status !== "connected" || !conn.client) {
        return { content: `MCP server "${serverId}" 当前不可用`, isError: true };
      }
      try {
        const outcome = await conn.client.callTool(
          { name: toolName, arguments: input },
          undefined,
          { signal: callOptions.signal },
        );
        return toToolResult(outcome);
      } catch (err) {
        // abort 让异常冒泡，交 tool-executor 统一中断；其余协议 / 连接错误转 isError。
        if (callOptions.signal?.aborted) throw err;
        return {
          content: `MCP 工具 "${toolName}"（${serverId}）调用失败：${
            err instanceof Error ? err.message : String(err)
          }`,
          isError: true,
        };
      }
    },

    async dispose() {
      await Promise.allSettled(
        [...connections.values()].map((conn) => conn.client?.close()),
      );
      connections.clear();
    },
  };
}

/** SDK 的 tool 描述 → 知行中性 McpToolDescriptor（只取映射层需要的字段）。 */
function toDescriptor(tool: {
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
