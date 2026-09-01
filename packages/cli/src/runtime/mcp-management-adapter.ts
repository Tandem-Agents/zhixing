import {
  fetchMcpServerSource,
  isValidServerId,
  probeServer,
  searchMcpServers,
} from "@zhixing/mcp";
import type { NetworkPolicy } from "@zhixing/network";
import type {
  McpManagementInfrastructurePort,
  McpManagementServerDraft,
  McpManagementServerStatus,
} from "../config-editor/mcp-management-contract.js";
import { toServerSpec } from "./mcp-config.js";

export interface CreateMcpManagementAdapterOptions {
  readonly proxy?: NetworkPolicy["proxy"];
  readonly readStatusWire: () => Promise<unknown>;
}

/** Host infrastructure edge for MCP status, one-shot probe and npm-backed discovery. */
export function createMcpManagementAdapter(
  options: CreateMcpManagementAdapterOptions,
): McpManagementInfrastructurePort {
  return Object.freeze({
    async snapshot(): Promise<readonly McpManagementServerStatus[]> {
      return decodeStatusSnapshot(await options.readStatusWire());
    },
    isServerIdValid: (serverId: string) => isValidServerId(serverId),
    async probe(draft: McpManagementServerDraft, signal?: AbortSignal) {
      const result = await probeServer(
        toServerSpec(
          draft.serverId,
          {
            type: draft.transport,
            ...(draft.command === undefined ? {} : { command: draft.command }),
            ...(draft.args === undefined ? {} : { args: [...draft.args] }),
            ...(draft.url === undefined ? {} : { url: draft.url }),
          },
          { ...draft.credentials },
        ),
        { proxy: options.proxy, ...(signal === undefined ? {} : { signal }) },
      );
      return result.ok
        ? Object.freeze({ ok: true as const })
        : Object.freeze({ ok: false as const, error: result.error });
    },
    async search(query: string, signal?: AbortSignal) {
      const results = await searchMcpServers(query, {
        proxy: options.proxy,
        ...(signal === undefined ? {} : { signal }),
      });
      return Object.freeze(results.map((result) => Object.freeze({
        name: result.name,
        description: result.description,
        keywords: Object.freeze([...result.keywords]),
        downloads: result.downloads,
      })));
    },
    async readSource(packageName: string, signal?: AbortSignal) {
      const result = await fetchMcpServerSource(packageName, {
        proxy: options.proxy,
        ...(signal === undefined ? {} : { signal }),
      });
      switch (result.kind) {
        case "found":
          return Object.freeze({
            kind: "found" as const,
            readme: result.readme,
            ...(result.homepage === undefined ? {} : { homepage: result.homepage }),
          });
        case "not-found":
          return Object.freeze({ kind: "not-found" as const });
        case "error":
          return Object.freeze({ kind: "error" as const, reason: result.reason });
      }
    },
  });
}

function decodeStatusSnapshot(input: unknown): readonly McpManagementServerStatus[] {
  if (!Array.isArray(input)) {
    throw new TypeError("MCP status snapshot must be an array");
  }
  return Object.freeze(input.map((item) => decodeStatus(item)));
}

function decodeStatus(input: unknown): McpManagementServerStatus {
  if (!isPlainRecord(input)) throw new TypeError("MCP status entry must be an object");
  const expected = input.error === undefined
    ? ["serverId", "status", "toolCount", "transport"]
    : ["error", "serverId", "status", "toolCount", "transport"];
  if (
    !hasExactKeys(input, expected) ||
    typeof input.serverId !== "string" ||
    (input.transport !== "stdio" && input.transport !== "http") ||
    (input.status !== "connected" && input.status !== "connecting") ||
    !Number.isSafeInteger(input.toolCount) ||
    (input.toolCount as number) < 0 ||
    (input.error !== undefined && typeof input.error !== "string")
  ) {
    throw new TypeError("MCP status entry is invalid");
  }
  return Object.freeze({
    serverId: input.serverId,
    transport: input.transport,
    status: input.status,
    toolCount: input.toolCount as number,
    ...(input.error === undefined ? {} : { error: input.error as string }),
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}
