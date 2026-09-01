/**
 * MCP management demand contract.
 *
 * The config editor owns only the finite values it presents and the operations it needs. Concrete
 * MCP SDK/server specifications, network clients and transport lifecycle stay behind the CLI Host
 * infrastructure adapter.
 */

export type McpManagementTransport = "stdio" | "http";

export interface McpManagementServerStatus {
  readonly serverId: string;
  readonly transport: McpManagementTransport;
  readonly status: "connected" | "connecting";
  readonly toolCount: number;
  readonly error?: string;
}

/** A path-free, secret-bearing draft used only for a one-shot connection probe. */
export interface McpManagementServerDraft {
  readonly serverId: string;
  readonly transport: McpManagementTransport;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly credentials: Readonly<Record<string, string>>;
}

export type McpManagementProbeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export interface McpManagementSearchResult {
  readonly name: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly downloads: number;
}

export type McpManagementSourceResult =
  | { readonly kind: "found"; readonly readme: string; readonly homepage?: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "error"; readonly reason: string };

export interface McpManagementStatusPort {
  snapshot(): Promise<readonly McpManagementServerStatus[]>;
}

export interface McpManagementProbePort {
  isServerIdValid(serverId: string): boolean;
  probe(
    draft: McpManagementServerDraft,
    signal?: AbortSignal,
  ): Promise<McpManagementProbeResult>;
}

export interface McpManagementDiscoveryPort {
  search(
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly McpManagementSearchResult[]>;
  readSource(
    packageName: string,
    signal?: AbortSignal,
  ): Promise<McpManagementSourceResult>;
}

export interface McpManagementInfrastructurePort
  extends McpManagementStatusPort,
    McpManagementProbePort,
    McpManagementDiscoveryPort {}
