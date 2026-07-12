import type { DeviceRole } from "@zhixing/core/contracts";
import type {
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
  readonly createExecutorRole: typeof createExecutorRole;
  readonly createInProcessRuntimeFactory: typeof createInProcessRuntimeFactory;
}

export interface AnchorRoleModule<Options> {
  run(options: Options, executor: ExecutorRoleModule): Promise<void>;
}

export interface ServeRoleLoaders<Options> {
  readonly anchor: () => Promise<AnchorRoleModule<Options>>;
  readonly executor: () => Promise<ExecutorRoleModule>;
}

export type ServeTopologyPlan = "disabled" | "single-process";

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
  if (hasAnchor && hasExecutor) return "single-process";

  // 单角色设备要等远程拓扑具备后才能启动；当前必须在加载任何角色前失败关闭。
  throw new UnsupportedServeRoleConfigurationError(configuration.roles);
}

/** 先完成角色规划和模块加载，再允许 anchor 打开监听器。 */
export async function runConfiguredServeTopology<Options>(
  configuration: ServeRoleConfiguration,
  loaders: ServeRoleLoaders<Options>,
  options: Options,
): Promise<void> {
  if (planServeTopology(configuration) === "disabled") return;

  const [anchor, executor] = await Promise.all([
    loaders.anchor(),
    loaders.executor(),
  ]);
  await anchor.run(options, executor);
}
