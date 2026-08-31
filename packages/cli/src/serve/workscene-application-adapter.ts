import type {
  WorksceneConversationStorageProjectionCleanupPort,
  WorksceneEntryPort,
  WorksceneManagementPort,
  WorksceneRuntimeProjectionReadPort,
  WorksceneWorkspaceAdministrationReadPort,
} from "@zhixing/core/workscene/application";
import { parseConversationId } from "@zhixing/core/conversation";
import type { AnchorWorksceneDirectory } from "./workscene-directory.js";

interface AnchorConversationStorageProjection {
  deleteStoredConversation(conversationId: string): Promise<boolean>;
}

/** Anchor mechanism adapter for the single Workscene-owned cleanup demand. */
export function createAnchorWorksceneConversationStorageProjectionCleanup(
  storage: AnchorConversationStorageProjection,
): WorksceneConversationStorageProjectionCleanupPort {
  const cleanup: WorksceneConversationStorageProjectionCleanupPort = {
    async removeCommittedProjection({ sceneId, conversationId }) {
      const parsed = parseConversationId(conversationId);
      if (
        parsed.scope.kind !== "workscene" ||
        parsed.scope.sceneId !== sceneId
      ) {
        throw Object.assign(
          new TypeError("Conversation does not belong to the workscene"),
          { code: "WORKSCENE_INPUT" },
        );
      }
      await storage.deleteStoredConversation(conversationId);
    },
  };
  return Object.freeze(cleanup);
}

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
  | "get"
>;

/** Maps the current Anchor mechanisms to the path-free Workscene application ports. */
export function createAnchorWorksceneApplicationPorts(
  directory: ApplicationDirectory,
): {
  readonly management: WorksceneManagementPort;
  readonly workspaces: WorksceneWorkspaceAdministrationReadPort;
  readonly entry: WorksceneEntryPort;
  readonly runtime: WorksceneRuntimeProjectionReadPort;
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
  const runtime: WorksceneRuntimeProjectionReadPort = {
    get: (sceneId) => directory.get(sceneId),
  };
  return Object.freeze({
    management: Object.freeze(management),
    workspaces: Object.freeze(workspaces),
    entry: Object.freeze(entry),
    runtime: Object.freeze(runtime),
  });
}
