import type {
  WorksceneEntryPort,
  WorksceneManagementPort,
  WorksceneWorkspaceAdministrationReadPort,
} from "@zhixing/core/workscene/application";
import type { AnchorWorksceneDirectory } from "./workscene-directory.js";

type ApplicationDirectory = Pick<
  AnchorWorksceneDirectory,
  | "list"
  | "create"
  | "rename"
  | "setWorkdir"
  | "remove"
  | "workspaceCatalog"
  | "enterScene"
  | "exitScene"
>;

/** Maps the current Anchor mechanisms to the path-free Workscene application ports. */
export function createAnchorWorksceneApplicationPorts(
  directory: ApplicationDirectory,
): {
  readonly management: WorksceneManagementPort;
  readonly workspaces: WorksceneWorkspaceAdministrationReadPort;
  readonly entry: WorksceneEntryPort;
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
  const entry: WorksceneEntryPort = {
    enter: (input) =>
      directory.enterScene(input.sceneId, input.observerId, {
        requestId: input.requestId,
      }),
    exit: (input) =>
      directory.exitScene(
        input.sceneId,
        input.conversationId,
        input.observerId,
        input.requestId,
      ),
  };
  return Object.freeze({
    management: Object.freeze(management),
    workspaces: Object.freeze(workspaces),
    entry: Object.freeze(entry),
  });
}
