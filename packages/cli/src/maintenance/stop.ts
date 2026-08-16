import { runStopCommand, type StopResult } from "../serve/stop.js";
import {
  prepareManagedServiceMaintenance,
  type ManagedServiceMaintenanceHandle,
} from "../serve/managed-service-runtime.js";

export interface MaintenanceStopDeps {
  readonly prepareManaged?: () => Promise<ManagedServiceMaintenanceHandle>;
  readonly stop?: () => Promise<StopResult>;
}

export async function runMaintenanceStop(
  deps: MaintenanceStopDeps = {},
): Promise<StopResult> {
  const managed = await (deps.prepareManaged ?? prepareManagedServiceMaintenance)();
  let committed = false;
  let rollbackAttempted = false;
  const rollback = async (): Promise<void> => {
    rollbackAttempted = true;
    await managed.rollback();
  };
  try {
    const result = await (deps.stop ?? runStopCommand)();
    if (result.status === "error" || result.status === "refused") {
      try {
        await rollback();
      } catch (rollbackError) {
        throw new AggregateError(
          [new Error(result.reason), rollbackError],
          "维护未开始，但托管启动状态无法安全恢复；请运行 zz doctor",
        );
      }
      return result;
    }
    await managed.commit();
    committed = true;
    return result;
  } catch (error) {
    if (!committed && !rollbackAttempted) {
      try {
        await rollback();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "维护未开始，但托管启动状态无法安全恢复；请运行 zz doctor",
        );
      }
    }
    throw error;
  }
}
