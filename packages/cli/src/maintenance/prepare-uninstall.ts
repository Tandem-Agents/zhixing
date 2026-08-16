import { runStopCommand, type StopResult } from "../serve/stop.js";
import {
  prepareProgramUninstallManagedService,
  type ProgramUninstallManagedServiceHandle,
} from "../serve/managed-service-runtime.js";

export interface PrepareApplicationUninstallDeps {
  readonly stop?: () => Promise<StopResult>;
  readonly prepareManaged?: () => Promise<ProgramUninstallManagedServiceHandle>;
}

export async function prepareApplicationUninstall(
  deps: PrepareApplicationUninstallDeps = {},
): Promise<void> {
  const managed = await (deps.prepareManaged ?? prepareProgramUninstallManagedService)();
  let committed = false;
  try {
    const result = await (deps.stop ?? (() => runStopCommand({ respectBlockers: true })))();
    if (result.status === "error" || result.status === "refused") {
      throw new Error("当前工作尚未安全结束，程序保持不变");
    }
    await managed.commit();
    committed = true;
  } catch (error) {
    if (!committed) {
      try {
        await managed.rollback();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "程序尚未卸载，但托管启动状态无法安全恢复；请运行 zz doctor",
        );
      }
    }
    throw error;
  }
}
