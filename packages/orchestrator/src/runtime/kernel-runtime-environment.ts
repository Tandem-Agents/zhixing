import type { AgentIdentity } from "@zhixing/core";

export type KernelWorkspaceSource =
  | "runtime"
  | "global-config"
  | "cwd-fallback"
  | "none";

export interface KernelRuntimeEnvironment {
  readonly agentIdentity: Readonly<AgentIdentity>;
  readonly sessionType: "interactive" | "ci";
  readonly workspace: {
    readonly path: string | null;
    readonly source: KernelWorkspaceSource;
  };
  readonly globalConfigPath: string;
  readonly networkProxy?: string;
}

export interface KernelRuntimeEnvironmentFactory {
  create(input: {
    readonly workspace?: string | null;
  }): KernelRuntimeEnvironment;
}

export function createKernelRuntimeEnvironment(
  input: KernelRuntimeEnvironment,
): KernelRuntimeEnvironment {
  const environment: KernelRuntimeEnvironment = Object.freeze({
    agentIdentity: Object.freeze({ ...input.agentIdentity }),
    sessionType: input.sessionType,
    workspace: Object.freeze({ ...input.workspace }),
    globalConfigPath: input.globalConfigPath,
    ...(input.networkProxy === undefined
      ? {}
      : { networkProxy: input.networkProxy }),
  });
  assertKernelRuntimeEnvironment(environment);
  return environment;
}

export function assertKernelRuntimeEnvironment(
  environment: KernelRuntimeEnvironment,
): void {
  const keys = Object.keys(environment).sort();
  const expected = environment.networkProxy === undefined
    ? ["agentIdentity", "globalConfigPath", "sessionType", "workspace"]
    : ["agentIdentity", "globalConfigPath", "networkProxy", "sessionType", "workspace"];
  const workspaceKeys = environment?.workspace
    ? Object.keys(environment.workspace).sort()
    : [];
  if (
    !environment ||
    !Object.isFrozen(environment) ||
    !Object.isFrozen(environment.agentIdentity) ||
    !environment.workspace ||
    !Object.isFrozen(environment.workspace) ||
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    workspaceKeys.length !== 2 ||
    workspaceKeys[0] !== "path" ||
    workspaceKeys[1] !== "source" ||
    typeof environment.agentIdentity.displayName !== "string" ||
    environment.agentIdentity.displayName.length === 0 ||
    (environment.sessionType !== "interactive" &&
      environment.sessionType !== "ci") ||
    typeof environment.globalConfigPath !== "string" ||
    environment.globalConfigPath.length === 0 ||
    (environment.networkProxy !== undefined &&
      typeof environment.networkProxy !== "string") ||
    (environment.workspace.path !== null &&
      typeof environment.workspace.path !== "string") ||
    !["runtime", "global-config", "cwd-fallback", "none"].includes(
      environment.workspace.source,
    ) ||
    (environment.workspace.path === null &&
      environment.workspace.source !== "none")
  ) {
    throw new TypeError("Kernel runtime environment must be finite and immutable");
  }
}
