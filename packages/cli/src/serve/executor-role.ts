import type { ServeOptions } from "./command.js";
import type {
  ExecutorRoleModule,
  ServeBootstrapContext,
} from "./role-topology.js";

/** Runs the executor role without loading an anchor owner, listener, or global authority. */
export async function run(
  options: ServeOptions,
  bootstrap: ServeBootstrapContext,
  executor?: ExecutorRoleModule,
): Promise<void> {
  const runtime = await import("./executor-role-runtime.js");
  await runtime.runExecutorRole(options, bootstrap, executor);
}
