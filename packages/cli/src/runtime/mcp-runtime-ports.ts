import type { ToolDefinition } from "@zhixing/core";

/** A fresh, immutable view of the MCP tools available to one runtime issue. */
export interface McpRuntimeToolProjection {
  readonly tools: readonly Readonly<ToolDefinition>[];
  readonly serverIds: readonly string[];
}

/** Runtime demand: obtain one coherent tool/catalog snapshot. */
export interface McpRuntimeToolProjectionPort {
  snapshot(): McpRuntimeToolProjection;
}

export interface McpRuntimeServerStatus {
  readonly serverId: string;
  readonly transport: "stdio" | "http";
  readonly status: "connected" | "connecting";
  readonly toolCount: number;
  readonly error?: string;
}

/** Management/status demand. It cannot mutate MCP configuration or connections. */
export interface McpRuntimeStatusProjectionPort {
  snapshot(): readonly McpRuntimeServerStatus[];
}

/** Host-owned connection lifecycle. Runtime consumers never receive this port. */
export interface McpRuntimeLifecyclePort {
  connect(): Promise<void>;
  close(): Promise<void>;
}

/** The three independent duties supplied by one concrete Host-owned MCP runtime. */
export interface HostMcpRuntimePorts {
  readonly tools: McpRuntimeToolProjectionPort;
  readonly status: McpRuntimeStatusProjectionPort;
  readonly lifecycle: McpRuntimeLifecyclePort;
}
