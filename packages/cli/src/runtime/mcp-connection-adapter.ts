import type {
  McpConnectionPort,
  McpSetupCandidate,
} from "@zhixing/core/mcp-management";
import { McpConnectionApplication } from "@zhixing/core/mcp-management";
import type { SecretStorePort } from "@zhixing/core/contracts";
import { canonicalize } from "@zhixing/core/protocol";
import {
  loadConfig,
  inspectMcpCredentialBinding,
  addMcpServerConfiguration,
  mcpConfigurationRevision,
  type CredentialStoreCoordinator,
  type McpCredentialProjection,
  type McpServerConfigEntry,
} from "@zhixing/providers";
import type { HostMcpRuntimePorts } from "./mcp-runtime-ports.js";

/** Configuration/Secret and MCP infrastructure; only finite, non-secret outcomes leave this edge. */
export function createMcpConnectionAdapter(options: {
  configPath: string;
  deviceId: string;
  credentials: McpCredentialProjection;
  configuredServers: Readonly<Record<string, McpServerConfigEntry>>;
  secretStore: SecretStorePort & CredentialStoreCoordinator;
  runtime: HostMcpRuntimePorts;
}): McpConnectionPort {
  const configPath = options.configPath;
  const installedEntries = new Map(
    Object.entries(structuredClone(options.configuredServers)),
  );
  const connected = (id: string) =>
    options.runtime.status
      .snapshot()
      .some((item) => item.serverId === id && item.status === "connected");
  const credentialsFor = async (candidate: McpSetupCandidate) => {
    if (candidate.secretFields.length === 0) return {};
    const existing = loadConfig({ configPath }).mcp?.servers?.[candidate.serverId];
    if (!existing || canonicalize(existing) !== canonicalize(candidate.entry)) return {};
    if (
      canonicalize(options.configuredServers[candidate.serverId] ?? null) !==
      canonicalize(candidate.entry)
    )
      return {};
    const bound = options.credentials.mcp?.[candidate.serverId] ?? {};
    return Object.fromEntries(
      candidate.secretFields.flatMap(({ key }) =>
        Object.hasOwn(bound, key) ? [[key, bound[key]!]] : [],
      ),
    );
  };
  return new McpConnectionApplication({
    async inspect(candidate, scope) {
      if (scope && scope.deviceId !== options.deviceId)
        return {
          unavailable:
            "接入请求属于另一台执行设备，未在当前设备安装；该设备需通过本地 MCP 管理入口接入，不能将凭据或配置复制到其他设备",
          conflict: false,
          credentialsReady: false,
          active: false,
          configured: false,
        };
      const existing = loadConfig({ configPath }).mcp?.servers?.[candidate.serverId];
      const binding = await inspectMcpCredentialBinding(candidate.serverId, options.credentials.mcp?.[candidate.serverId], {
        store: options.secretStore,
      });
      if (!binding.matches) throw new Error("该 MCP 的凭据已变化，须由宿主生命周期重新装配");
      const credentialConflict =
        binding.exists &&
        canonicalize(options.configuredServers[candidate.serverId] ?? null) !==
          canonicalize(candidate.entry);
      const secrets = await credentialsFor(candidate);
      return {
        conflict:
          credentialConflict ||
          Boolean(
            installedEntries.has(candidate.serverId) &&
              canonicalize(installedEntries.get(candidate.serverId)) !==
                canonicalize(candidate.entry),
          ) ||
          Boolean(
            scope &&
              !existing &&
              scope.configurationRevision !== mcpConfigurationRevision({ configPath }),
          ) ||
          Boolean(existing && canonicalize(existing) !== canonicalize(candidate.entry)),
        credentialsReady: candidate.secretFields.every((field) =>
          Boolean(secrets[field.key]?.trim()),
        ),
        configured: Boolean(existing),
        active: Boolean(
          existing &&
            canonicalize(installedEntries.get(candidate.serverId) ?? null) ===
              canonicalize(candidate.entry) &&
            connected(candidate.serverId),
        ),
      };
    },
    commit: (candidate, scope) =>
      addMcpServerConfiguration(candidate.serverId, candidate.entry, {
        configPath,
        expectedRevision: scope?.configurationRevision,
      }),
    async activate(candidate) {
      if (!options.runtime.lifecycle.add) return false;
      const binding = await inspectMcpCredentialBinding(candidate.serverId, options.credentials.mcp?.[candidate.serverId], {
        store: options.secretStore,
      });
      if (!binding.matches) return false;
      const existing = loadConfig({ configPath }).mcp?.servers?.[candidate.serverId];
      if (!existing || canonicalize(existing) !== canonicalize(candidate.entry)) return false;
      const secrets = await credentialsFor(candidate);
      await options.runtime.lifecycle.add({
        serverId: candidate.serverId,
        transport: candidate.entry.type ?? "stdio",
        command: candidate.entry.command,
        args: candidate.entry.args,
        url: candidate.entry.url,
        credentials: secrets,
      });
      installedEntries.set(candidate.serverId, structuredClone(candidate.entry));
      return connected(candidate.serverId);
    },
  });
}
