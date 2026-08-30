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
  type ZhixingConfig,
} from "@zhixing/providers";

export function createTrustAdministrationRepository(): TrustAdministrationRepository {
  return createPermissionStoreTrustAdministrationRepository(
    () => new PermissionStore(),
  );
}

/** Host composition of the one Trust Administration application. */
export function createTrustAdministrationApplication(deps: {
  readonly config: ZhixingConfig;
  readonly sessionType?: WorkspaceSessionType;
}): TrustAdministrationApplication {
  return new TrustAdministrationApplicationService({
    repository: createTrustAdministrationRepository(),
    defaultContext: () => {
      const sessionType = deps.sessionType ?? resolveWorkspaceSessionType();
      const workspace = resolveWorkspace(deps.config, { sessionType });
      return workspace.path
        ? {
            kind: "workspace",
            hash: PermissionStore.workspaceHashFromPath(workspace.path),
          }
        : { kind: "main" };
    },
  });
}
