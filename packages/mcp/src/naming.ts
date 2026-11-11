/**
 * MCP 工具命名的公开出口 —— `mcp__<server>__<tool>` 三段式。
 *
 * 命名规则（消毒、长度预算、去重、反解析）的唯一实现位于 `@zhixing-ai/core/mcp-management`，
 * 终端展示层直接从那里反解析工具名，不加载 MCP 宿主。本模块保持 MCP 包原有的命名 API，
 * 映射层与包外调用方经此使用同一实现。
 */

export {
  isValidMcpServerId as isValidServerId,
  makeMcpToolName as makeToolName,
  makeUniqueMcpToolName as makeUniqueToolName,
  parseMcpToolName as parseToolName,
  sanitizeMcpToolName as sanitizeToolName,
} from "@zhixing-ai/core/mcp-management";
