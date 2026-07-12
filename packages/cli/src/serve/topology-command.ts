import type { ServeOptions } from "./command.js";
import {
  runConfiguredServeTopology,
  type ServeRoleConfiguration,
} from "./role-topology.js";

export {
  DEFAULT_LOCAL_ROLE_CONFIGURATION,
  type ServeRoleConfiguration,
} from "./role-topology.js";
export type { ServeOptions };

export async function runServeCommand(
  options: ServeOptions,
  configuration: ServeRoleConfiguration,
): Promise<void> {
  await runConfiguredServeTopology(
    configuration,
    {
      anchor: () => import("./anchor-role.js"),
      executor: () => import("@zhixing/executor"),
    },
    options,
  );
}
