import { randomUUID } from "node:crypto";
import {
  CoreHostConnection,
  defaultCoreHostConnectionDeps,
} from "./core-host-connection.js";
import { RpcManagementFacade } from "./rpc-management-facade.js";

export async function listDutyMigrationTargets(): Promise<void> {
  await withManagement(async (management) => {
    const targets = await management.dutyMigrationTargets();
    if (targets.length === 0) {
      console.log("当前没有可迁移的已配对设备。请先确认目标设备在线并已启用值班能力。");
      return;
    }
    console.log("可迁移的值班设备：");
    for (const target of targets) console.log(`- ${target.displayName}（${target.deviceId}）`);
  });
}

export async function prepareDutyMigration(
  targetDeviceId: string,
  continueImmediately: boolean,
): Promise<void> {
  const transferId = `duty-${randomUUID()}`;
  const requestId = requestIdFor(transferId);
  await withManagement(async (management) => {
    console.log("正在检查目标设备并准备迁移……");
    await management.dutyMigrationPrepare({ requestId, transferId, targetDeviceId });
    console.log("目标设备已就绪，当前设备尚未切换。此时仍可取消。");
    if (!continueImmediately) {
      console.log(`迁移编号：${transferId}`);
      console.log(`继续：zz duty continue ${transferId}`);
      console.log(`取消：zz duty cancel ${transferId}`);
      return;
    }
    await completeDutyMigration(management, transferId);
  });
}

export async function continueDutyMigration(transferId: string): Promise<void> {
  await withManagement((management) => completeDutyMigration(management, transferId));
}

export async function cancelDutyMigration(transferId: string): Promise<void> {
  await withManagement(async (management) => {
    await management.dutyMigrationCancel({
      requestId: requestIdFor(transferId),
      transferId,
    });
    console.log("值班设备迁移已取消，当前设备继续服务。");
  });
}

async function completeDutyMigration(
  management: RpcManagementFacade,
  transferId: string,
): Promise<void> {
  console.log("正在收束当前任务并传输耐久状态，请保持两台设备在线……");
  await management.dutyMigrationCommit({
    requestId: requestIdFor(transferId),
    transferId,
  });
  console.log("值班设备迁移完成。后续操作将由新设备处理；如需迁回，请再次发起迁移。");
}

async function withManagement<T>(
  operation: (management: RpcManagementFacade) => Promise<T>,
): Promise<T> {
  const coreHost = new CoreHostConnection(defaultCoreHostConnectionDeps());
  try {
    await coreHost.ensure();
    return await operation(new RpcManagementFacade(coreHost));
  } finally {
    await coreHost.dispose();
  }
}

function requestIdFor(transferId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(transferId)) {
    throw new TypeError("迁移编号无效");
  }
  return `request:${transferId}`;
}
