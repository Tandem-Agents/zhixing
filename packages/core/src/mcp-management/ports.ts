/**
 * MCP management demand contract.
 *
 * Product-owned finite inputs and outcomes shared by user and model bindings.
 * MCP SDK specifications, network clients, secret storage and transport lifecycle
 * remain behind infrastructure ports.
 */

export type McpManagementTransport = "stdio" | "http";

export type McpManagementFailureStage =
  | "spawn"
  | "connect"
  | "list-tools"
  | "call-tool"
  | "disconnected";

export type McpManagementFailureReason =
  | "command-not-found"
  | "spawn-error"
  | "timeout"
  | "connection-refused"
  | "http-auth"
  | "http-status"
  | "protocol-error"
  | "tool-error-result"
  | "network-blocked"
  | "closed"
  | "unknown";

export interface McpManagementPublicFailure {
  readonly stage: McpManagementFailureStage;
  readonly reason: McpManagementFailureReason;
  readonly statusCode?: number;
  readonly contentBlocks?: number;
  readonly contentBytes?: number;
}

export interface McpManagementServerStatus {
  readonly serverId: string;
  readonly transport: McpManagementTransport;
  readonly status: "connected" | "connecting";
  readonly toolCount: number;
  readonly error?: string;
}

export interface McpManagementServerStatusV2 extends McpManagementServerStatus {
  readonly failure?: McpManagementPublicFailure;
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
  | {
      readonly ok: false;
      readonly error: string;
      readonly failure?: McpManagementPublicFailure;
    };

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
  snapshotV2?(): Promise<readonly McpManagementServerStatusV2[]>;
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
