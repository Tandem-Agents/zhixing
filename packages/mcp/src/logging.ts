import type { LogSource } from "@zhixing/core/logging";

export const MCP_LOG_SOURCE: LogSource = {
  id: "mcp", version: 1,
  events: {
    connecting: { message: "MCP 连接尝试开始", level: "info", tier: "critical", fields: { server: "text", transport: "text" } },
    connected: { message: "MCP 工具目录已就绪", level: "info", tier: "critical", fields: { server: "text", toolCount: "number" } },
    retry: { message: "MCP 连接等待重试", level: "warn", tier: "critical", fields: { server: "text", error: "text", attempt: "number" } },
    closed: { message: "MCP 连接清理已结束", level: "info", tier: "critical", fields: { server: "text" } },
    requested: { message: "MCP 工具请求已发出", level: "info", tier: "critical", fields: { server: "text", tool: "text" } },
    returned: { message: "MCP 工具请求已结束", level: "info", tier: "critical", fields: { server: "text", tool: "text", error: "text", outputChars: "number", duration: "number" } },
  },
};
