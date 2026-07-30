import {
  CoreHostConnection,
  defaultCoreHostConnectionDeps,
} from "./core-host-connection.js";
import { createStdoutWriter } from "../screen/cli-writer.js";
import { RpcLocalWorkspaceFacade } from "./rpc-local-workspace-facade.js";
import { WORKSPACE_CATALOG_RESET_IMPACT } from "./workspace-reset-impact.js";

export { WORKSPACE_CATALOG_RESET_IMPACT };

export async function runWorkspaceCommand(
  operation: (
    workspace: RpcLocalWorkspaceFacade,
  ) => Promise<unknown>,
): Promise<void> {
  const connection = new CoreHostConnection(
    defaultCoreHostConnectionDeps(),
  );
  try {
    const result = await operation(new RpcLocalWorkspaceFacade(connection));
    if (result !== undefined) {
      createStdoutWriter().line(JSON.stringify(result, null, 2));
    }
  } finally {
    await connection.dispose();
  }
}
