import type { ZhixingConfig } from "@zhixing/providers";

declare const runtimeConfigurationProjectionBrand: unique symbol;

type RuntimeConfigurationProjection<
  Keys extends keyof ZhixingConfig,
  Purpose extends string,
> = Readonly<Pick<ZhixingConfig, Keys>> & {
  readonly [runtimeConfigurationProjectionBrand]: Purpose;
};

export type RuntimeTopologyConfigurationProjection = RuntimeConfigurationProjection<
  "mesh",
  "topology"
>;

export type RuntimeModelConfigurationProjection = RuntimeConfigurationProjection<
  "llm" | "modelCapabilityOverrides",
  "model"
>;

export type RuntimeKernelEnvironmentConfigurationProjection =
  RuntimeConfigurationProjection<
    "agent" | "workspace" | "network",
    "kernel-environment"
  >;

export type RuntimeAdvancementConfigurationProjection =
  RuntimeConfigurationProjection<
    "llm" | "workspace" | "advancement" | "modelCapabilityOverrides",
    "advancement"
  >;

export type RuntimeMcpConfigurationProjection = RuntimeConfigurationProjection<
  "mcp" | "network",
  "mcp"
>;

export type RuntimeChannelConfigurationProjection = RuntimeConfigurationProjection<
  "messaging" | "intent",
  "channel"
>;

export type RuntimeWorkspaceConfigurationProjection = RuntimeConfigurationProjection<
  "workspace",
  "workspace"
>;

export type RuntimeCredentialRotationConfigurationProjection =
  RuntimeConfigurationProjection<"llm" | "messaging", "credential-rotation">;

/**
 * Durable executor/readiness identity currently hashes the complete validated
 * public configuration. This dedicated projection preserves that existing
 * identity contract without exposing the process snapshot type or source.
 */
export type RuntimeAuthorityConfigurationProjection = RuntimeConfigurationProjection<
  keyof ZhixingConfig,
  "authority-identity"
>;

export interface RuntimeConfigurationProjections {
  readonly topology: RuntimeTopologyConfigurationProjection;
  readonly model: RuntimeModelConfigurationProjection;
  readonly kernelEnvironment: RuntimeKernelEnvironmentConfigurationProjection;
  readonly advancement: RuntimeAdvancementConfigurationProjection;
  readonly mcp: RuntimeMcpConfigurationProjection;
  readonly channel: RuntimeChannelConfigurationProjection;
  readonly workspace: RuntimeWorkspaceConfigurationProjection;
  readonly credentialRotation: RuntimeCredentialRotationConfigurationProjection;
  readonly authority: RuntimeAuthorityConfigurationProjection;
}

const TOPOLOGY_KEYS = ["mesh"] as const;
const MODEL_KEYS = ["llm", "modelCapabilityOverrides"] as const;
const KERNEL_ENVIRONMENT_KEYS = ["agent", "workspace", "network"] as const;
const ADVANCEMENT_KEYS = [
  "llm",
  "workspace",
  "advancement",
  "modelCapabilityOverrides",
] as const;
const MCP_KEYS = ["mcp", "network"] as const;
const CHANNEL_KEYS = ["messaging", "intent"] as const;
const WORKSPACE_KEYS = ["workspace"] as const;
const CREDENTIAL_ROTATION_KEYS = ["llm", "messaging"] as const;
const AUTHORITY_KEYS = [
  "mesh",
  "llm",
  "messaging",
  "mcp",
  "agent",
  "intent",
  "workspace",
  "network",
  "advancement",
  "modelCapabilityOverrides",
] as const satisfies readonly (keyof ZhixingConfig)[];

/**
 * The persistent Host and transient workspace composition root each call this
 * once. Every returned purpose value owns a separate deep-cloned object graph;
 * downstream components never receive the complete process snapshot.
 */
export function projectRuntimeConfiguration(
  configuration: Readonly<ZhixingConfig>,
): RuntimeConfigurationProjections {
  return Object.freeze({
    topology: project(configuration, TOPOLOGY_KEYS, "topology"),
    model: project(configuration, MODEL_KEYS, "model"),
    kernelEnvironment: project(
      configuration,
      KERNEL_ENVIRONMENT_KEYS,
      "kernel-environment",
    ),
    advancement: project(configuration, ADVANCEMENT_KEYS, "advancement"),
    mcp: project(configuration, MCP_KEYS, "mcp"),
    channel: project(configuration, CHANNEL_KEYS, "channel"),
    workspace: project(configuration, WORKSPACE_KEYS, "workspace"),
    credentialRotation: project(
      configuration,
      CREDENTIAL_ROTATION_KEYS,
      "credential-rotation",
    ),
    authority: project(configuration, AUTHORITY_KEYS, "authority-identity"),
  });
}

function project<
  const Keys extends readonly (keyof ZhixingConfig)[],
  const Purpose extends string,
>(
  configuration: Readonly<ZhixingConfig>,
  keys: Keys,
  _purpose: Purpose,
): RuntimeConfigurationProjection<Keys[number], Purpose> {
  const selected: Partial<ZhixingConfig> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(configuration, key)) {
      Object.defineProperty(selected, key, {
        configurable: true,
        enumerable: true,
        value: structuredClone(configuration[key]),
        writable: true,
      });
    }
  }
  return deepFreeze(selected) as RuntimeConfigurationProjection<
    Keys[number],
    Purpose
  >;
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
