import type { DeviceRole } from "@zhixing/core/contracts";
import {
  LocalWorkspaceManagementHost,
  createLocalWorkspaceManagementHost,
} from "./local-workspace-management-host.js";
import {
  acquireLocalWorkspaceOwner,
  type LocalWorkspaceOwnerLease,
} from "./local-workspace-owner.js";

export async function acquireExecutorLocalWorkspaceOwner(
  zhixingHome: string,
  roles: readonly DeviceRole[],
): Promise<LocalWorkspaceOwnerLease | undefined> {
  return roles.includes("executor")
    ? acquireLocalWorkspaceOwner(zhixingHome)
    : undefined;
}

export async function startExecutorLocalWorkspaceHost(input: {
  readonly roles: readonly DeviceRole[];
  readonly lease?: LocalWorkspaceOwnerLease;
  readonly host: Omit<
    Parameters<typeof createLocalWorkspaceManagementHost>[0],
    "lease"
  >;
}): Promise<LocalWorkspaceManagementHost | undefined> {
  if (!input.roles.includes("executor")) {
    if (input.lease) {
      throw new Error("A non-executor topology cannot own local workspace management");
    }
    return undefined;
  }
  if (!input.lease) {
    throw new Error("Executor topology did not acquire local workspace management ownership");
  }
  const host = createLocalWorkspaceManagementHost({
    ...input.host,
    lease: input.lease,
  });
  await host.start();
  return host;
}
