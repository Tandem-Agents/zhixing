import type { ZhixingCredentials } from "@zhixing/providers";
import { compareCanonicalStrings } from "@zhixing/core/protocol";
import type { ExecutorReadiness } from "../setup-delivery.js";

export interface ExecutorCapabilityCatalog {
  capabilityCatalog(): {
    readonly tools: readonly string[];
    readonly mcpServers: readonly string[];
  };
}

/** Derives the published executor snapshot from the same runtime assets that execute work. */
export function createExecutorReadinessSource(input: {
  readonly runtime: ExecutorCapabilityCatalog;
  readonly credentials: ZhixingCredentials;
  readonly credentialGeneration: string | null;
}): () => ExecutorReadiness {
  const credentialBindings = [
    ...Object.entries(input.credentials.providers ?? {})
      .filter(([, entry]) => entry.apiKey.trim().length > 0)
      .map(([providerId]) => ({
        bindingId: `credential-provider-${providerId}`,
        service: `provider-${providerId}`,
        verification: "user-alias" as const,
      })),
    ...Object.entries(input.credentials.mcp ?? {})
      .filter(([, entry]) => Object.values(entry).some((value) => value.trim().length > 0))
      .map(([serverId]) => ({
        bindingId: `credential-mcp-${serverId}`,
        service: `mcp-${serverId}`,
        verification: "user-alias" as const,
      })),
  ].sort((left, right) => compareCanonicalStrings(left.bindingId, right.bindingId));

  return () => {
    const catalog = input.runtime.capabilityCatalog();
    return {
      tools: catalog.tools,
      mcpServers: catalog.mcpServers,
      credentialBindings,
      deviceScopedCredentialBindingIds: credentialBindings.map(
        (binding) => binding.bindingId,
      ),
      credentialGeneration: input.credentialGeneration,
    };
  };
}
