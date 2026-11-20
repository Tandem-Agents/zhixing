import type {
  ChannelCredentialProjection,
  McpCredentialProjection,
  ProviderCredentialProjection,
  ZhixingCredentials,
} from "@zhixing-ai/providers";

export interface CredentialExposureSecretProjection {
  readonly providers?: ProviderCredentialProjection["providers"];
  readonly modelSecrets?: ProviderCredentialProjection["modelSecrets"];
  readonly protectedLegacyProviders?: ProviderCredentialProjection["protectedLegacyProviders"];
  readonly revokedModelSecretRefs?: ProviderCredentialProjection["revokedModelSecretRefs"];
  readonly compromisedModelSecretTokens?: ProviderCredentialProjection["compromisedModelSecretTokens"];
  readonly mcp?: McpCredentialProjection["mcp"];
}

export interface CredentialRotationSecretProjection
  extends CredentialExposureSecretProjection {
  readonly channels?: ChannelCredentialProjection["channels"];
}

export interface RuntimeSecretProjections {
  readonly providerCredentials: ProviderCredentialProjection;
  readonly mcpCredentials: McpCredentialProjection;
  readonly channelCredentials: ChannelCredentialProjection;
  readonly credentialExposureCredentials: CredentialExposureSecretProjection;
  readonly credentialRotationCredentials: CredentialRotationSecretProjection;
}

/**
 * The startup secret edge is the only runtime boundary that sees the aggregate
 * credential schema. Every downstream consumer receives one frozen purpose
 * projection, with nested containers cloned and frozen before publication.
 */
export function projectRuntimeSecrets(
  credentials: ZhixingCredentials,
): RuntimeSecretProjections {
  const providers = credentials.providers === undefined
    ? undefined
    : freezeClone(credentials.providers);
  const modelSecrets = credentials.modelSecrets === undefined
    ? undefined
    : freezeClone(credentials.modelSecrets);
  const protectedLegacyProviders = credentials.protectedLegacyProviders === undefined
    ? undefined
    : freezeClone(credentials.protectedLegacyProviders);
  const revokedModelSecretRefs = credentials.revokedModelSecretRefs === undefined
    ? undefined
    : Object.freeze([...credentials.revokedModelSecretRefs]);
  const compromisedModelSecretTokens = credentials.compromisedModelSecretTokens === undefined
    ? undefined
    : freezeClone(credentials.compromisedModelSecretTokens);
  const mcp = credentials.mcp === undefined
    ? undefined
    : freezeClone(credentials.mcp);
  const channels = credentials.channels === undefined
    ? undefined
    : freezeClone(credentials.channels);

  const v2ModelFields = {
    ...(modelSecrets === undefined ? {} : { modelSecrets }),
    ...(protectedLegacyProviders === undefined ? {} : { protectedLegacyProviders }),
    ...(revokedModelSecretRefs === undefined ? {} : { revokedModelSecretRefs }),
    ...(compromisedModelSecretTokens === undefined ? {} : { compromisedModelSecretTokens }),
  };

  return Object.freeze({
    providerCredentials: Object.freeze({
      ...(providers === undefined ? {} : { providers }),
      ...v2ModelFields,
    }),
    mcpCredentials: Object.freeze(mcp === undefined ? {} : { mcp }),
    channelCredentials: Object.freeze(
      channels === undefined ? {} : { channels },
    ),
    credentialExposureCredentials: Object.freeze({
      ...(providers === undefined ? {} : { providers }),
      ...v2ModelFields,
      ...(mcp === undefined ? {} : { mcp }),
    }),
    credentialRotationCredentials: Object.freeze({
      ...(providers === undefined ? {} : { providers }),
      ...v2ModelFields,
      ...(mcp === undefined ? {} : { mcp }),
      ...(channels === undefined ? {} : { channels }),
    }),
  });
}

function freezeClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
