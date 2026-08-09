import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import {
  CoreHostConnection,
  defaultCoreHostConnectionDeps,
} from "./core-host-connection.js";
import {
  RpcManagementFacade,
  type DutyMigrationTarget,
} from "./rpc-management-facade.js";

export interface DutyMigrationSelectionIO {
  readonly interactive: boolean;
  selectIndex(targets: readonly DutyMigrationTarget[]): Promise<number>;
}

export async function listDutyMigrationTargets(): Promise<void> {
  await withManagement(async (management) => {
    const targets = await management.dutyMigrationTargets();
    if (targets.length === 0) {
      console.log("当前没有可迁移的已配对设备。请先确认目标设备在线并已启用值班能力。");
      return;
    }
    console.log("可迁移的值班设备：");
    for (const target of targets) {
      console.log(`- ${target.displayName}：${target.ready ? "可接班" : "暂不可用"}`);
    }
  });
}

export async function prepareDutyMigration(
  deviceName: string | undefined,
  continueImmediately: boolean,
): Promise<void> {
  const transferId = createDutyMigrationTransferId();
  const requestId = requestIdFor(transferId);
  await withManagement(async (management) => {
    const target = await selectDutyMigrationTarget(management, deviceName);
    console.log("正在检查目标设备并准备迁移……");
    await management.dutyMigrationPrepare({
      requestId,
      transferId,
      targetDeviceId: target.deviceId,
    });
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

export function createDutyMigrationTransferId(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) {
    throw new TypeError("迁移时间超出有效范围");
  }
  const entropy = randomBytes(10);
  let value = BigInt(now);
  for (const byte of entropy) value = (value << 8n) | BigInt(byte);
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = alphabet[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return `xfer-${encoded}`;
}

export async function selectDutyMigrationTarget(
  management: Pick<RpcManagementFacade, "dutyMigrationTargets">,
  deviceName: string | undefined,
  io: DutyMigrationSelectionIO = defaultSelectionIO(),
) {
  const targets = await management.dutyMigrationTargets();
  const requested = deviceName?.trim();
  if (requested) {
    const matches = targets.filter((target) => target.displayName === requested);
    if (matches.length !== 1) {
      throw new TypeError(matches.length === 0
        ? `没有名为“${requested}”的可迁移设备`
        : `存在多个名为“${requested}”的设备，请先为设备设置唯一名称`);
    }
    if (!matches[0]!.ready) {
      throw new Error(`“${requested}”当前暂不可接班，请确认设备在线且值班配置完整`);
    }
    return matches[0]!;
  }
  if (!io.interactive) {
    throw new TypeError("非交互环境必须提供唯一的目标设备名称");
  }
  const ready = targets.filter((target) => target.ready);
  if (ready.length === 0) {
    throw new Error("当前没有可接班的设备，请确认目标设备在线且值班配置完整");
  }
  const index = await io.selectIndex(ready);
  if (!Number.isSafeInteger(index) || index < 0 || index >= ready.length) {
    throw new TypeError("设备序号无效");
  }
  return ready[index]!;
}

function defaultSelectionIO(): DutyMigrationSelectionIO {
  return {
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    async selectIndex(targets) {
      console.log("请选择接班设备：");
      targets.forEach((target, index) => console.log(`${index + 1}. ${target.displayName}`));
      const reader = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return Number((await reader.question("序号：")).trim()) - 1;
      } finally {
        reader.close();
      }
    },
  };
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
