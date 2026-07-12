import type { ServeOptions } from "./command.js";
import type { ExecutorRoleModule } from "./role-topology.js";

/** Anchor 角色入口保持无导入副作用；真正监听只在 run 调用后开始。 */
export async function run(
  options: ServeOptions,
  executor: ExecutorRoleModule,
): Promise<void> {
  const anchor = await import("./command.js");
  await anchor.runServeCommand(options, executor);
}
