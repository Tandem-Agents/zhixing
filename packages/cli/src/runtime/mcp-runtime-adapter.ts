import {
  createMcpHub,
  mapServerTools,
  type McpHub,
  type McpHubOptions,
  type McpServerSpec,
} from "@zhixing/mcp";
import { canonicalize } from "@zhixing/core/protocol";
import type { McpManagementServerDraft } from "@zhixing/core/mcp-management";
import { toServerSpec } from "./mcp-config.js";
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
  return adaptMcpHub(createMcpHub(specs, options), specs);
}

/** Kept at the infrastructure edge so the adapter can be tested without a transport. */
export function adaptMcpHub(hub: McpHub, initialSpecs: readonly McpServerSpec[] = []): HostMcpRuntimePorts {
  const specs = new Map(initialSpecs.map((spec) => [spec.serverId, spec]));
  let tail: Promise<void> = Promise.resolve();
  let closing = false;
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
    add(draft: McpManagementServerDraft): Promise<void> {
      if (closing) return Promise.reject(new Error("MCP 宿主正在关闭"));
      const spec = toServerSpec(draft.serverId, { type: draft.transport, command: draft.command, args: draft.args && [...draft.args], url: draft.url }, { ...draft.credentials });
      const next = tail.then(async () => {
        const current = specs.get(spec.serverId);
        if (current) {
          if (canonicalize(current) !== canonicalize(spec)) throw new Error("不能在运行中替换已有 MCP 服务");
          return;
        }
        const nextSpecs = [...specs.values(), spec];
        await hub.applyConfig(nextSpecs);
        specs.set(spec.serverId, spec);
      });
      tail = next.catch(() => {});
      return next;
    },
    connect: () => hub.connectAll(),
    close: async () => { closing = true; await tail; await hub.dispose(); },
  });
  return Object.freeze({ tools, status, lifecycle });
}
