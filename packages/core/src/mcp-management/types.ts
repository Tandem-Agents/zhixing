/** MCP 接入决策；凭据只由秘密提供者保存，不属于此合同。 */
export interface McpServerConfigEntry {
  type?: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  enabled?: boolean;
  tools?: { include?: string[]; exclude?: string[] };
}

/** Reserves enough of the 64-character tool name budget for each server's tools. */
export function isValidMcpServerId(id: string): boolean {
  return id.length <= 40 && !id.includes("__") && /^[a-zA-Z0-9](?:[a-zA-Z0-9_-]*[a-zA-Z0-9])?$/.test(id);
}
