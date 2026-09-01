import type { DeviceRole, SecretStorePort } from "@zhixing/core/contracts";
import type {
  ChannelCredentialProjection,
  CredentialStoreCoordinator,
  McpCredentialProjection,
  ProviderCredentialProjection,
} from "@zhixing/providers";
import type { CleanupRegistrationOwner } from "@zhixing/server";
import type { DeviceCapacityRuntime } from "./device-capacity-runtime.js";
import type { MeshRuntimeBootstrap } from "./mesh-runtime-bootstrap.js";
import type { LocalWorkspaceAssemblyIdentity } from "../runtime/local-workspace-bootstrap.js";
import type {
  CredentialExposureSecretProjection,
  CredentialRotationSecretProjection,
} from "../runtime/runtime-secret-projections.js";
import type { RuntimeConfigurationSnapshot } from "../runtime/runtime-configuration-snapshot.js";
import type {
  ConversationAssignmentLedger,
  AssignmentStreamSpool,
  AssignmentStreamWriter,
  DataPlaneTicketRegistry,
  ExecutorResourceGovernor,
  InProcessAssignmentSubmission,
  createExecutorRole,
  createInProcessAssignmentRuntimeFactory,
  createInProcessRuntimeFactory,
} from "@zhixing/executor";

const VALID_DEVICE_ROLES: ReadonlySet<string> = new Set([
  "anchor",
  "executor",
  "surface",
]);

export interface ServeRoleConfiguration {
  readonly roles: readonly DeviceRole[];
}
export const DEFAULT_LOCAL_ROLE_CONFIGURATION = {
  roles: ["anchor", "executor"],
} as const satisfies ServeRoleConfiguration;

export class UnsupportedServeRoleConfigurationError extends Error {
  readonly roles: readonly string[];

  constructor(roles: readonly string[]) {
    super(`当前拓扑无法启动角色组合: ${roles.join(", ") || "none"}`);
    this.name = "UnsupportedServeRoleConfigurationError";
    this.roles = [...roles];
  }
}

export interface ExecutorRoleModule {
  readonly ConversationAssignmentLedger: typeof ConversationAssignmentLedger;
  readonly AssignmentStreamSpool: typeof AssignmentStreamSpool;
  readonly AssignmentStreamWriter: typeof AssignmentStreamWriter;
  readonly DataPlaneTicketRegistry: typeof DataPlaneTicketRegistry;
  readonly ExecutorResourceGovernor: typeof ExecutorResourceGovernor;
  readonly InProcessAssignmentSubmission: typeof InProcessAssignmentSubmission;
  readonly createExecutorRole: typeof createExecutorRole;
  readonly createInProcessAssignmentRuntimeFactory:
    typeof createInProcessAssignmentRuntimeFactory;
  readonly createInProcessRuntimeFactory: typeof createInProcessRuntimeFactory;
}

export interface ServeBootstrapContext {
  readonly mesh: MeshRuntimeBootstrap;
  readonly deviceCapacity: DeviceCapacityRuntime;
  readonly secretStore: SecretStorePort & CredentialStoreCoordinator;
  readonly runtimeConfiguration: RuntimeConfigurationSnapshot;
  readonly credentialGeneration: string | null;
  readonly localWorkspaceIdentity: LocalWorkspaceAssemblyIdentity;
}

export interface AnchorServeBootstrapContext extends ServeBootstrapContext {
  readonly providerCredentials: ProviderCredentialProjection;
  readonly mcpCredentials: McpCredentialProjection;
  readonly channelCredentials: ChannelCredentialProjection;
  readonly credentialExposureCredentials: CredentialExposureSecretProjection;
  readonly credentialRotationCredentials: CredentialRotationSecretProjection;
}

export interface ExecutorServeBootstrapContext extends ServeBootstrapContext {
  readonly providerCredentials: ProviderCredentialProjection;
  readonly mcpCredentials: McpCredentialProjection;
  readonly credentialExposureCredentials: CredentialExposureSecretProjection;
}

export type ServeHostKind = "disabled" | "anchor-host" | "executor-host";

export interface ServeTopologyPlan {
  readonly host: ServeHostKind;
  readonly loadExecutor: boolean;
  readonly activeCleanupOwners: readonly CleanupRegistrationOwner[];
}

export function planServeTopology(
  configuration: ServeRoleConfiguration,
): ServeTopologyPlan {
  if (configuration.roles.some((role) => !VALID_DEVICE_ROLES.has(role))) {
    throw new UnsupportedServeRoleConfigurationError(configuration.roles);
  }
  const roles = new Set(configuration.roles);
  if (roles.size !== configuration.roles.length) {
    throw new UnsupportedServeRoleConfigurationError(configuration.roles);
  }

  const hasAnchor = roles.has("anchor");
  const hasExecutor = roles.has("executor");
  if (!hasAnchor && !hasExecutor) {
    return {
      host: "disabled",
      loadExecutor: false,
      activeCleanupOwners: [],
    };
  }
  if (!hasAnchor) {
    return {
      host: "executor-host",
      loadExecutor: true,
      activeCleanupOwners: [],
    };
  }
  return {
    host: "anchor-host",
    loadExecutor: hasExecutor,
    activeCleanupOwners: hasExecutor
      ? ["anchor-host", "anchor-local-executor"]
      : ["anchor-host"],
  };
}
