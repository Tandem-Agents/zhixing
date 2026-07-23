import type { DeviceRole, SecretStorePort } from "@zhixing/core/contracts";
import type { CredentialStoreCoordinator } from "@zhixing/providers";
import type { StartupCheckResult } from "../startup.js";
import type { MeshRuntimeBootstrap } from "./mesh-runtime-bootstrap.js";
import type {
  ConversationAssignmentLedger,
  ExecutorResourceGovernor,
  InProcessAssignmentSubmission,
  createExecutorRole,
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
  readonly ExecutorResourceGovernor: typeof ExecutorResourceGovernor;
  readonly InProcessAssignmentSubmission: typeof InProcessAssignmentSubmission;
  readonly createExecutorRole: typeof createExecutorRole;
  readonly createInProcessRuntimeFactory: typeof createInProcessRuntimeFactory;
}

export interface ServeBootstrapContext {
  readonly mesh: MeshRuntimeBootstrap;
  readonly secretStore: SecretStorePort & CredentialStoreCoordinator;
  readonly startup: Extract<StartupCheckResult, { readonly kind: "ready" }>;
}

export interface ServiceHostModule<Options> {
  run(
    options: Options,
    bootstrap: ServeBootstrapContext,
    executor?: ExecutorRoleModule,
  ): Promise<void>;
}

export interface ServeRoleLoaders<Options> {
  readonly anchorHost: () => Promise<ServiceHostModule<Options>>;
  readonly executorHost: () => Promise<ServiceHostModule<Options>>;
  readonly executor: () => Promise<ExecutorRoleModule>;
}

export type ServeTopologyPlan = "disabled" | "anchor-host" | "executor-host";

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
  if (!hasAnchor && !hasExecutor) return "disabled";
  return hasAnchor ? "anchor-host" : "executor-host";
}

/** 先完成角色规划与按需模块加载，再允许产品宿主产生运行时副作用。 */
export async function runConfiguredServeTopology<Options>(
  configuration: ServeRoleConfiguration,
  loaders: ServeRoleLoaders<Options>,
  options: Options,
  bootstrap: ServeBootstrapContext,
): Promise<void> {
  const plan = planServeTopology(configuration);
  if (plan === "disabled") return;

  const [host, executor] = await Promise.all([
    plan === "anchor-host" ? loaders.anchorHost() : loaders.executorHost(),
    configuration.roles.includes("executor")
      ? loaders.executor()
      : Promise.resolve(undefined),
  ]);
  await host.run(options, bootstrap, executor);
}
