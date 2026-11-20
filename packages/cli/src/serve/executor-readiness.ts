import { compareCanonicalStrings } from "@zhixing-ai/core/protocol";
import type { ExecutorReadiness } from "../setup-delivery.js";
import type { CredentialExposureSecretProjection } from "../runtime/runtime-secret-projections.js";
import type { ModelRuntimePort } from "../runtime/model-runtime-port.js";

export interface ExecutorCapabilityCatalog {
  capabilityCatalog(): {
    readonly tools: readonly string[];
    readonly mcpServers: readonly string[];
  };
}

/** Derives the published executor snapshot from the same runtime assets that execute work. */
export function createExecutorReadinessSource(input: {
  readonly runtime: ExecutorCapabilityCatalog;
  readonly credentials: CredentialExposureSecretProjection;
  readonly credentialGeneration: string | null;
  readonly modelRuntimePort?: ModelRuntimePort;
}): () => ExecutorReadiness {
  const mcpBindings = Object.entries(input.credentials.mcp ?? {})
    .filter(([, entry]) => Object.values(entry).some((value) => value.trim().length > 0))
    .map(([serverId]) => ({
      bindingId: `credential-mcp-${serverId}`,
      service: `mcp-${serverId}`,
      verification: "user-alias" as const,
    }));

  const staticProviderBindings = Object.entries(input.credentials.providers ?? {})
    .filter(([, entry]) => entry.apiKey.trim().length > 0)
    .map(([providerId]) => ({
      bindingId: `credential-provider-${providerId}`,
      service: `provider-${providerId}`,
      verification: "user-alias" as const,
    }));

  return () => {
    const catalog = input.runtime.capabilityCatalog();
    const liveModel = input.modelRuntimePort?.readiness();
    const providerBindings = liveModel
      ? liveModel.credentialBindings
      : staticProviderBindings;
    const credentialBindings = [...providerBindings, ...mcpBindings].sort(
      (left, right) => compareCanonicalStrings(left.bindingId, right.bindingId),
    );
    return {
      tools: catalog.tools,
      mcpServers: catalog.mcpServers,
      credentialBindings,
      deviceScopedCredentialBindingIds: credentialBindings.map(
        (binding) => binding.bindingId,
      ),
      credentialGeneration: liveModel
        ? liveModel.credentialGeneration
        : input.credentialGeneration,
      ...(liveModel && liveModel.modelConnections.length > 0
        ? { modelConnections: liveModel.modelConnections }
        : {}),
      ...(liveModel && liveModel.readyRoles.length > 0
        ? { readyRoles: liveModel.readyRoles }
        : {}),
    };
  };
}
