import type { ChannelStatus, LLMProvider, Message } from "@zhixing/core";
import type { SecretRef } from "@zhixing/core/contracts";
import { canonicalize, protocolDigest } from "@zhixing/core/protocol";
import type { McpServerStatus } from "@zhixing/mcp";
import {
  createProvider,
  resolveProvider,
  type ProviderCredentialProjection,
  type ZhixingConfig,
} from "@zhixing/providers";
import type { CredentialExposureRecord } from "@zhixing/core/contracts";
import { CredentialExposureAuthority } from "./credential-exposure-authority.js";
import type { CredentialRotationSecretProjection } from "../runtime/runtime-secret-projections.js";

type CredentialKind = "provider" | "channel" | "mcp";

interface CurrentCredentialBinding {
  readonly kind: CredentialKind;
  readonly id: string;
  readonly logicalBindingId: string;
  readonly bindingId: string;
  readonly service: string;
  readonly value: unknown;
}

export interface CredentialRotationPublicationOptions {
  readonly authority: CredentialExposureAuthority;
  readonly deviceId: string;
  readonly config: ZhixingConfig;
  readonly credentials: CredentialRotationSecretProjection;
  readonly credentialGeneration: string | null;
  readonly readCredentials: () => Promise<CredentialRotationSecretProjection>;
  readonly mcpStatuses: () => readonly McpServerStatus[];
  readonly channelStatuses: () => readonly ChannelStatus[];
  readonly waitForChannels?: () => Promise<void>;
  /** Production provider probes must enter the shared authority control governor. */
  readonly governProvider?: (provider: LLMProvider) => LLMProvider;
  readonly probeProvider?: (input: {
    readonly providerId: string;
    readonly model: string;
    readonly config: ZhixingConfig;
    readonly credentials: ProviderCredentialProjection;
  }) => Promise<string>;
  readonly now?: () => string;
}

/**
 * Completes only the finite credential rotations already demanded by the
 * durable exposure projection. It neither rotates third-party credentials nor
 * creates a second readiness source.
 */
export async function publishRequiredCredentialRotations(
  options: CredentialRotationPublicationOptions,
): Promise<void> {
  const bindings = currentCredentialBindings(options);
  if (bindings.length === 0) return;

  let projection = await options.authority.projection();
  const compromised = projection.records.filter((record) =>
    record.state === "compromised");
  if (compromised.length === 0) return;
  if (!options.credentialGeneration) {
    throw new Error("Credential rotation requires a committed SecretStore generation");
  }

  for (const old of compromised) {
    const matches = bindings.filter((binding) =>
      binding.service === old.service &&
      binding.logicalBindingId === logicalBindingId(old.bindingId));
    if (matches.length === 0) continue;
    if (matches.length !== 1) {
      throw new Error("Credential rotation binding is ambiguous");
    }
    const binding = matches[0]!;
    const revision = nextBindingRevision(projection.records, binding, old);
    const requestId = protocolDigest("CredentialRotationRequest", 1, {
      credentialGeneration: options.credentialGeneration,
      deviceId: options.deviceId,
      oldDeviceId: old.deviceId,
      oldBindingId: old.bindingId,
      bindingId: binding.bindingId,
      service: binding.service,
      revision,
    });
    const readiness = readinessFor(binding, options);
    projection = await options.authority.publishRotation({
      requestId,
      oldDeviceId: old.deviceId,
      oldBindingId: old.bindingId,
      ref: {
        kind: binding.kind,
        bindingId: binding.bindingId,
      } satisfies SecretRef,
      service: binding.service,
      bindingRevision: revision,
      verifyPrincipal: async () => ({
        verification: "service-verified",
        canonicalProviderPrincipal: await readiness.verify(),
      }),
      publishAndReadBack: async () => {
        const stored = await options.readCredentials();
        const exact = credentialValue(stored, binding);
        if (canonicalize(exact) !== canonicalize(binding.value)) {
          throw new Error("Credential rotation SecretStore read-back does not match the saved binding");
        }
      },
      readiness: readiness.assertCurrent,
      ...(old.tenant ? { tenant: old.tenant } : {}),
      ...(old.scopes ? { scopes: old.scopes } : {}),
      ...(old.rotationHint ? { rotationHint: old.rotationHint } : {}),
    });
  }
}

function currentCredentialBindings(
  options: CredentialRotationPublicationOptions,
): CurrentCredentialBinding[] {
  const bindings: CurrentCredentialBinding[] = [];
  for (const [id, entry] of Object.entries(options.credentials.providers ?? {})) {
    if (entry.apiKey.trim().length === 0) continue;
    bindings.push(binding("provider", id, `provider-${id}`, entry, options.deviceId));
  }
  for (const [id, entry] of Object.entries(options.credentials.mcp ?? {})) {
    if (!Object.values(entry).some((value) => value.trim().length > 0)) continue;
    bindings.push(binding("mcp", id, `mcp-${id}`, entry, options.deviceId));
  }
  for (const [id, entry] of Object.entries(options.credentials.channels ?? {})) {
    if (!options.config.messaging?.[id]) continue;
    if (!Object.values(entry).some((value) => value.trim().length > 0)) continue;
    bindings.push(binding("channel", id, `channel-${id}`, entry, options.deviceId));
  }
  return bindings.sort((left, right) =>
    `${left.service}/${left.bindingId}`.localeCompare(
      `${right.service}/${right.bindingId}`,
      "en-US",
    ));
}

function binding(
  kind: CredentialKind,
  id: string,
  service: string,
  value: unknown,
  deviceId: string,
): CurrentCredentialBinding {
  const logicalBindingId = `credential-${kind}-${id}`;
  return Object.freeze({
    kind,
    id,
    logicalBindingId,
    bindingId: `user-alias:${deviceId}:${logicalBindingId}`,
    service,
    value,
  });
}

function logicalBindingId(bindingId: string): string {
  const match = /^user-alias:[^:]+:(.+)$/u.exec(bindingId);
  return match?.[1] ?? bindingId;
}

function nextBindingRevision(
  records: readonly CredentialExposureRecord[],
  binding: CurrentCredentialBinding,
  old?: CredentialExposureRecord,
): number {
  const revisions = records
    .filter((record) =>
      record.bindingId === binding.bindingId &&
      record.service === binding.service)
    .map((record) => record.bindingRevision ?? 0);
  if (old?.bindingRevision !== undefined) revisions.push(old.bindingRevision);
  return Math.max(0, ...revisions) + (old ? 1 : revisions.length === 0 ? 1 : 0);
}

function credentialValue(
  credentials: CredentialRotationSecretProjection,
  binding: CurrentCredentialBinding,
): unknown {
  switch (binding.kind) {
    case "provider":
      return credentials.providers?.[binding.id];
    case "channel":
      return credentials.channels?.[binding.id];
    case "mcp":
      return credentials.mcp?.[binding.id];
  }
}

function readinessFor(
  binding: CurrentCredentialBinding,
  options: CredentialRotationPublicationOptions,
): { readonly verify: () => Promise<string>; readonly assertCurrent: () => Promise<void> } {
  switch (binding.kind) {
    case "provider": {
      const model = providerModel(options.config, binding.id);
      if (!model) throw new Error(`Credential rotation provider is not active: ${binding.id}`);
      let verified = false;
      return {
        verify: async () => {
          const principal = await (options.probeProvider ?? ((input) => {
            if (!options.governProvider) {
              throw new Error("Credential provider verification governor is not configured");
            }
            return probeProviderCredential(input, options.governProvider);
          }))({
            providerId: binding.id,
            model,
            config: options.config,
            credentials: options.credentials.providers
              ? { providers: options.credentials.providers }
              : {},
          });
          verified = true;
          return principal;
        },
        assertCurrent: async () => {
          if (!verified || providerModel(options.config, binding.id) !== model) {
            throw new Error("Credential rotation provider readiness changed");
          }
        },
      };
    }
    case "mcp": {
      const assertConnected = () => {
        const status = options.mcpStatuses().find((item) => item.serverId === binding.id);
        if (!status || status.status !== "connected") {
          throw new Error(`Credential rotation MCP service is not connected: ${binding.id}`);
        }
        return status;
      };
      return {
        verify: async () => {
          const status = assertConnected();
          return `mcp:${binding.id}:${status.transport}`;
        },
        assertCurrent: async () => { assertConnected(); },
      };
    }
    case "channel": {
      const adapterId = options.config.messaging?.[binding.id]?.type ?? binding.id;
      const assertConnected = () => {
        const status = options.channelStatuses().find((item) => item.channelId === adapterId);
        if (!status || status.state !== "connected") {
          throw new Error(`Credential rotation channel is not connected: ${binding.id}`);
        }
      };
      return {
        verify: async () => {
          await options.waitForChannels?.();
          assertConnected();
          const entry = options.credentials.channels?.[binding.id] ?? {};
          return `channel:${binding.id}:${entry.appId ?? adapterId}`;
        },
        assertCurrent: async () => { assertConnected(); },
      };
    }
  }
}

function providerModel(config: ZhixingConfig, providerId: string): string | undefined {
  for (const role of [config.llm?.main, config.llm?.light, config.llm?.power]) {
    if (role?.provider === providerId) return role.model;
  }
  return undefined;
}

async function probeProviderCredential(input: {
  readonly providerId: string;
  readonly model: string;
  readonly config: ZhixingConfig;
  readonly credentials: ProviderCredentialProjection;
}, governProvider: (provider: LLMProvider) => LLMProvider): Promise<string> {
  const credentials = input.credentials.providers
    ? { providers: input.credentials.providers }
    : {};
  const resolved = resolveProvider(input.providerId, credentials);
  const provider = governProvider(
    createProvider(input.config, credentials, input.providerId),
  );
  const abort = new AbortController();
  const timer = setTimeout(
    () => abort.abort(new Error("Credential provider verification timed out")),
    15_000,
  );
  let completed = false;
  try {
    const messages: Message[] = [{
      role: "user",
      content: [{ type: "text", text: "Reply with OK." }],
    }];
    for await (const event of provider.chat({
      model: input.model,
      messages,
      maxTokens: 1,
      temperature: 0,
      abortSignal: abort.signal,
    })) {
      if (event.type === "error") throw event.error;
      if (event.type === "message_end") completed = true;
    }
  } finally {
    clearTimeout(timer);
  }
  if (!completed) throw new Error("Credential provider verification did not complete");
  return `provider:${resolved.id}:${resolved.baseUrl}`;
}
