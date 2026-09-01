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

/** Host composition of the one Trust Administration application. */
export function createTrustAdministrationApplication(deps: {
  readonly configuration: RuntimeWorkspaceConfigurationProjection;
  readonly repository: TrustAdministrationRepository;
  readonly workspaceIdentity: (workspacePath: string) => string;
  readonly sessionType?: WorkspaceSessionType;
}): TrustAdministrationApplication {
  return new TrustAdministrationApplicationService({
    repository: deps.repository,
    defaultContext: () => {
      const sessionType = deps.sessionType ?? resolveWorkspaceSessionType();
      const workspace = resolveWorkspace(deps.configuration, { sessionType });
      return workspace.path
        ? {
            kind: "workspace",
            hash: deps.workspaceIdentity(workspace.path),
          }
        : { kind: "main" };
    },
  });
}
