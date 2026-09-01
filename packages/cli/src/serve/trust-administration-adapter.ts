import {
  createPermissionStoreTrustAdministrationRepository,
  PermissionStore,
} from "@zhixing/core/security";
import {
  TrustAdministrationApplicationService,
  type TrustAdministrationApplication,
  type TrustAdministrationRepository,
} from "@zhixing/core/trust-administration";
import {
  resolveWorkspace,
  resolveWorkspaceSessionType,
  type WorkspaceSessionType,
} from "@zhixing/providers";
import type { RuntimeWorkspaceConfigurationProjection } from "../runtime/runtime-configuration-projections.js";

export function createTrustAdministrationRepository(): TrustAdministrationRepository {
  return createPermissionStoreTrustAdministrationRepository(
    () => new PermissionStore(),
  );
}

/** Host composition of the one Trust Administration application. */
export function createTrustAdministrationApplication(deps: {
  readonly configuration: RuntimeWorkspaceConfigurationProjection;
  readonly sessionType?: WorkspaceSessionType;
}): TrustAdministrationApplication {
  return new TrustAdministrationApplicationService({
    repository: createTrustAdministrationRepository(),
    defaultContext: () => {
      const sessionType = deps.sessionType ?? resolveWorkspaceSessionType();
      const workspace = resolveWorkspace(deps.configuration, { sessionType });
      return workspace.path
        ? {
            kind: "workspace",
            hash: PermissionStore.workspaceHashFromPath(workspace.path),
          }
        : { kind: "main" };
    },
  });
}
