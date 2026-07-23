import type { ServeOptions } from "./command.js";
import type {
  ExecutorRoleModule,
  ServeBootstrapContext,
} from "./role-topology.js";

/** 产品宿主入口保持无导入副作用；角色专属资源只在 run 调用后装配。 */
export async function run(
  options: ServeOptions,
  bootstrap: ServeBootstrapContext,
  executor?: ExecutorRoleModule,
): Promise<void> {
  const host = await import("./command.js");
  await host.runServeCommand(options, bootstrap, executor);
}
