import type {
  WorksceneManagementPort,
  WorksceneWorkspaceAdministrationReadPort,
} from "@zhixing/core/workscene/application";
import type { AnchorWorksceneDirectory } from "./workscene-directory.js";

type ManagementDirectory = Pick<
  AnchorWorksceneDirectory,
  "list" | "create" | "rename" | "setWorkdir" | "remove" | "workspaceCatalog"
>;

/** Maps the current Anchor mechanisms to the path-free Workscene application ports. */
export function createAnchorWorksceneManagementPorts(
  directory: ManagementDirectory,
): {
  readonly management: WorksceneManagementPort;
  readonly workspaces: WorksceneWorkspaceAdministrationReadPort;
} {
  const management: WorksceneManagementPort = {
    list: () => directory.list(),
    create: (input) => directory.create(input),
    rename: (input) =>
      directory.rename(input.sceneId, input.name, input.requestId),
    setWorkspace: (input) =>
      directory.setWorkdir(input.sceneId, input.workspace, input.requestId),
    delete: (input) => directory.remove(input.sceneId, input.requestId),
  };
  const workspaces: WorksceneWorkspaceAdministrationReadPort = {
    list: async () =>
      (await directory.workspaceCatalog()).map((workspace) =>
        Object.freeze({ ...workspace })
      ),
  };
  return Object.freeze({
    management: Object.freeze(management),
    workspaces: Object.freeze(workspaces),
  });
}
