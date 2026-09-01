import path from "node:path";
import {
  bindPermissionRuleExecutionSource,
  createPermissionStoreTrustAdministrationRepository,
  PermissionStore,
  toPermissionContext,
  type PermissionStoreOptions,
} from "@zhixing/core/security";
import type {
  TrustAdministrationRepository,
} from "@zhixing/core/trust-administration";
import type {
  KernelPermissionStorageBinding,
  KernelPermissionStorageFactory,
} from "@zhixing/orchestrator/runtime";

export interface PermissionStorageInfrastructure {
  /** Fresh read-through management role; it never shares a runtime session pool. */
  readonly management: TrustAdministrationRepository;
  /** Stable workspace identity projection used by Trust Administration. */
  readonly workspaceIdentity: (workspacePath: string) => string;
  /** Runtime-scoped execution storage factory consumed by the Kernel boundary. */
  readonly runtime: KernelPermissionStorageFactory;
}

/**
 * The single Host infrastructure owner for the P04 permission file mechanism.
 *
 * Runtime stores remain instance-scoped so session rules live exactly as long
 * as their AgentRuntime. Management operations use fresh read-through stores so
 * a revoke observes the latest durable file rather than another runtime's cache.
 */
export function createPermissionStorageInfrastructure(input: Readonly<{
  zhixingHome: string;
}>): PermissionStorageInfrastructure {
  const rootDir = path.join(input.zhixingHome, "permissions");
  const createStore = (
    extractArgument?: PermissionStoreOptions["extractArgument"],
  ) =>
    new PermissionStore({
      rootDir,
      ...(extractArgument ? { extractArgument } : {}),
    });

  const management = createPermissionStoreTrustAdministrationRepository(
    () => createStore(),
  );
  const runtime: KernelPermissionStorageFactory = Object.freeze({
    create: ((request) => {
      const store = createStore(request.extractArgument);
      for (const contribution of request.builtinRuleSets) {
        store.registerBuiltinRules(
          contribution.namespace,
          [...contribution.rules],
        );
      }
      const repository = createPermissionStoreTrustAdministrationRepository(
        () => store,
      );
      return Object.freeze({
        trustAdministration: repository,
        rulesFor: ((context) =>
          bindPermissionRuleExecutionSource(
            store,
            toPermissionContext(context),
          )) satisfies KernelPermissionStorageBinding["rulesFor"],
      });
    }) satisfies KernelPermissionStorageFactory["create"],
  });

  return Object.freeze({
    management,
    workspaceIdentity: PermissionStore.workspaceHashFromPath,
    runtime,
  });
}
