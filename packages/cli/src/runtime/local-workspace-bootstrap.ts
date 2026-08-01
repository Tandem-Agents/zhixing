import type { DeviceRole } from "@zhixing/core/contracts";
import {
  LocalWorkspaceManagementHost,
  createLocalWorkspaceManagementHost,
} from "./local-workspace-management-host.js";
import {
  acquireLocalWorkspaceOwner,
  type LocalWorkspaceOwnerLease,
} from "./local-workspace-owner.js";

export type LocalWorkspaceAssemblyIdentity =
  | { readonly kind: "executor"; readonly lease: LocalWorkspaceOwnerLease }
  | { readonly kind: "non-executor" };

export async function acquireExecutorLocalWorkspaceOwner(
  zhixingHome: string,
  roles: readonly DeviceRole[],
): Promise<LocalWorkspaceOwnerLease | undefined> {
  return roles.includes("executor")
    ? acquireLocalWorkspaceOwner(zhixingHome)
    : undefined;
}

export function defineLocalWorkspaceAssemblyIdentity(
  roles: readonly DeviceRole[],
  lease: LocalWorkspaceOwnerLease | undefined,
): LocalWorkspaceAssemblyIdentity {
  if (roles.includes("executor")) {
    if (!lease) {
      throw new Error("Executor topology did not acquire local workspace management ownership");
    }
    return { kind: "executor", lease };
  }
  if (lease) {
    throw new Error("A non-executor topology cannot own local workspace management");
  }
  return { kind: "non-executor" };
}

export async function startExecutorLocalWorkspaceHost(input: {
  readonly identity: LocalWorkspaceAssemblyIdentity;
  readonly host: Omit<
    Parameters<typeof createLocalWorkspaceManagementHost>[0],
    "lease"
  >;
}): Promise<LocalWorkspaceManagementHost | undefined> {
  if (input.identity.kind === "non-executor") return undefined;
  const host = createLocalWorkspaceManagementHost({
    ...input.host,
    lease: input.identity.lease,
  });
  await host.start();
  return host;
}
