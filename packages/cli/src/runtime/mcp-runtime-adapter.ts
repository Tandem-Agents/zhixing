import {
  createMcpHub,
  mapServerTools,
  type McpHub,
  type McpHubOptions,
  type McpServerSpec,
} from "@zhixing/mcp";
import type {
  HostMcpRuntimePorts,
  McpRuntimeServerStatus,
  McpRuntimeToolProjection,
} from "./mcp-runtime-ports.js";

/** Infrastructure edge: create the concrete hub and expose only demand-owned ports. */
export function createHostMcpRuntime(
  specs: readonly McpServerSpec[],
  options: McpHubOptions = {},
): HostMcpRuntimePorts {
  return adaptMcpHub(createMcpHub(specs, options));
}

/** Kept at the infrastructure edge so the adapter can be tested without a transport. */
export function adaptMcpHub(hub: McpHub): HostMcpRuntimePorts {
  const tools = Object.freeze({
    snapshot(): McpRuntimeToolProjection {
      const catalog = hub.catalog();
      return Object.freeze({
        tools: Object.freeze(
          catalog.flatMap(({ server, tools: descriptors }) =>
            mapServerTools(server, descriptors, hub.callTool)
          ).map((tool) => Object.freeze({ ...tool })),
        ),
        serverIds: Object.freeze(catalog.map(({ server }) => server.serverId).sort()),
      });
    },
  });
  const status = Object.freeze({
    snapshot(): readonly McpRuntimeServerStatus[] {
      return Object.freeze(hub.serverStatuses().map((item) => Object.freeze({
        serverId: item.serverId,
        transport: item.transport,
        status: item.status,
        toolCount: item.toolCount,
        ...(item.error === undefined ? {} : { error: item.error }),
      })));
    },
  });
  const lifecycle = Object.freeze({
    connect: () => hub.connectAll(),
    close: () => hub.dispose(),
  });
  return Object.freeze({ tools, status, lifecycle });
}
