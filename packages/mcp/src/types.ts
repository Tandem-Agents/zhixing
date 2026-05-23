/**
 * MCP host 的内部类型 —— 知行对"已发现的 MCP 工具"与"调用通道"的自有表示。
 *
 * 刻意不直接复用 `@modelcontextprotocol/sdk` 的类型：连接层（hub）负责把 SDK 的
 * Tool / CallToolResult 翻译成这里的中性表示，映射层（mapping）只认这些类型。
 * 由此映射层与 SDK 解耦，可脱离真实连接独立单测，SDK 升级也不会穿透到映射逻辑。
 */

import type { ToolResult } from "@zhixing/core";

/** MCP server 的传输方式 —— 决定映射出工具的中断语义（stdio 持有子进程需优雅停止）。 */
export type McpTransportKind = "stdio" | "http";

/**
 * 一个 server 连接的上下文 —— server 级（而非工具级）元信息。
 *
 * serverId / transport 对该 server 的**所有**工具都是常量，因此作为批级上下文一次性
 * 传入映射层，而非塞进每个工具描述。这样从类型上消除两类本不该表达的无效状态：
 * 同批工具混入异 server 数据、同批 transport 不一致。也贴合 SDK 的 `Tool` 本就不
 * 携带 server 信息这一数据本质。
 */
export interface McpServerContext {
  /** server 的 id（`config.mcp.servers` 的 key）。 */
  serverId: string;
  /** 该 server 的传输方式 —— 决定映射出工具的 interruptBehavior。 */
  transport: McpTransportKind;
}

/**
 * 一个已被 `tools/list` 发现的 MCP 工具的中性描述 —— 仅含工具自身属性。
 * 由 hub 从 SDK 的 Tool 物化（SDK 的 Tool 同样不含 server 信息）。
 */
export interface McpToolDescriptor {
  /** MCP 原始工具名 —— 转发 `tools/call` 时用它，而非消毒后的知行工具名。 */
  name: string;
  /** 工具描述（可能很长，映射时截断）。 */
  description?: string;
  /** MCP 原始 inputSchema —— 透传给 LLM；映射层只校验顶层为 object。 */
  inputSchema: unknown;
  /** `annotations.readOnlyHint` —— 缺省按 fail-closed 视为有副作用。 */
  readOnlyHint?: boolean;
}

/**
 * 调用某个 MCP 工具的通道 —— 由 hub 实现、注入给 mapping（依赖倒置）。
 *
 * 约定：实现方（hub）负责把 MCP 调用结果翻译成知行 ToolResult（content 文本 +
 * isError），并把协议 / 连接错误也转成 isError 的 ToolResult 而非抛异常。映射层
 * 仍会再包一层 try/catch 作为防御，符合 tool-executor 对工具"错误即 isError、不
 * 抛异常"的隔离契约。
 */
export type McpCallFn = (
  serverId: string,
  toolName: string,
  input: Record<string, unknown>,
  options: { signal?: AbortSignal },
) => Promise<ToolResult>;
