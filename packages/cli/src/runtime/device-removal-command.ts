import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import {
  CoreHostConnection,
  defaultCoreHostConnectionDeps,
} from "./core-host-connection.js";
import {
  RpcManagementFacade,
  type DeviceRemovalCandidate,
  type DeviceRemovalState,
} from "./rpc-management-facade.js";

export type DeviceRemovalMode = "transfer" | "destroy" | "lost" | "cancel";

export interface DeviceRemovalSelectionIO {
  readonly interactive: boolean;
  selectIndex(devices: readonly DeviceRemovalCandidate[]): Promise<number>;
  confirm(message: string): Promise<boolean>;
  chooseMode(conversations: readonly string[]): Promise<"transfer" | "destroy" | "cancel">;
}

export async function listRemovableDevices(): Promise<void> {
  await withManagement(async (management) => {
    const devices = await management.deviceList();
    if (devices.length === 0) {
      console.log("当前没有可移除的已配对设备。");
      return;
    }
    console.log("已配对设备：");
    for (const device of devices) {
      console.log(`- ${device.displayName}：${device.reachable ? "在线" : "当前离线"}`);
    }
  });
}

export async function removeDevice(input: {
  readonly targetName?: string;
  readonly mode?: Exclude<DeviceRemovalMode, "cancel">;
  readonly confirmed?: boolean;
  readonly permanent?: boolean;
}, io: DeviceRemovalSelectionIO = defaultSelectionIO()): Promise<void> {
  if (input.permanent !== true) {
    throw new TypeError("永久移除设备必须显式提供 --permanent");
  }
  await withManagement(async (management) => {
    const device = await selectRemovalTarget(management, input.targetName, io);
    const operationId = createDeviceRemovalOperationId();
    const requestId = `request:${operationId}`;
    const preflight = await management.deviceRemove({
      requestId,
      operationId,
      targetName: device.displayName,
    });
    console.log(`“${device.displayName}”的移除操作已安全登记。`);
    if (input.mode === "lost") {
      renderState(await management.deviceContinue({
        targetName: device.displayName,
        mode: "lost",
      }));
      return;
    }
    let mode: "transfer" | "destroy" | "cancel" | undefined = input.mode;
    if (!mode) {
      mode = preflight.conversations.length === 0
        ? "transfer"
        : io.interactive
        ? await io.chooseMode(preflight.conversations)
        : undefined;
    }
    if (!mode) {
      throw new TypeError("非交互环境必须用 --mode transfer、--mode destroy 或 --mode lost 明确处理方式");
    }
    const work = preflight.conversations.length === 0
      ? "没有未转移的本机对话"
      : `未转移的本机对话：${preflight.conversations.join("、")}`;
    const consequence = mode === "destroy"
      ? "这些本机数据将永久删除，无法恢复"
      : "本机工作收束后将永久撤销该设备的访问";
    await requireConfirmation(
      io,
      input.confirmed,
      `永久移除设备“${device.displayName}”。${work}；${consequence}。继续吗？`,
    );
    renderState(await management.deviceContinue({
      targetName: device.displayName,
      mode,
    }));
  });
}

export async function continueDeviceRemoval(input: {
  readonly targetName: string;
  readonly mode: DeviceRemovalMode;
  readonly confirmed?: boolean;
}, io: DeviceRemovalSelectionIO = defaultSelectionIO()): Promise<void> {
  if (input.mode === "destroy" || input.mode === "lost") {
    await requireConfirmation(
      io,
      input.confirmed,
      input.mode === "lost"
        ? "目标设备本地数据仍不可验证或擦除；只撤销访问。继续吗？"
        : "该操作会永久删除目标设备上的本地权威数据。继续吗？",
    );
  }
  await withManagement(async (management) => {
    renderState(await management.deviceContinue(input));
  });
}

export async function showDeviceRemovalStatus(
  targetName: string,
): Promise<void> {
  await withManagement(async (management) => {
    const state = await management.deviceStatus({ targetName });
    if (!state) {
      console.log("没有找到该设备移除操作。");
      return;
    }
    renderState(state);
  });
}

export async function selectRemovalTarget(
  management: Pick<RpcManagementFacade, "deviceList">,
  requestedName: string | undefined,
  io: DeviceRemovalSelectionIO = defaultSelectionIO(),
): Promise<DeviceRemovalCandidate> {
  const devices = await management.deviceList();
  const requested = requestedName?.trim();
  if (requested) {
    const matches = devices.filter((device) => device.displayName === requested);
    if (matches.length !== 1) {
      throw new TypeError(matches.length === 0
        ? `没有名为“${requested}”的可移除设备`
        : `存在多个名为“${requested}”的设备，请先为设备设置唯一名称`);
    }
    return matches[0]!;
  }
  if (!io.interactive) throw new TypeError("非交互环境必须提供唯一的设备名称");
  if (devices.length === 0) throw new Error("当前没有可移除的已配对设备");
  const index = await io.selectIndex(devices);
  if (!Number.isSafeInteger(index) || index < 0 || index >= devices.length) {
    throw new TypeError("设备序号无效");
  }
  return devices[index]!;
}

export function createDeviceRemovalOperationId(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) {
    throw new TypeError("设备移除时间超出有效范围");
  }
  return `remove-${now.toString(36)}-${randomBytes(10).toString("base64url")}`;
}

function renderState(state: DeviceRemovalState): void {
  const label: Record<DeviceRemovalState["phase"], string> = {
    "waiting-for-device": "正在等待设备重新上线",
    "needs-conversation-decision": "需先处理目标设备上的本机对话",
    "moving-conversations": "正在收束目标设备上的本机对话",
    "revoking-access": "本机工作已收束，正在撤销设备访问",
    "cleaning-device": "访问已撤销，正在清理目标设备本地数据",
    removed: state.localData === "unknown"
      ? "设备访问已撤销；目标设备本地数据仍不可验证或擦除"
      : "设备已安全移除",
    cancelled: "设备移除已取消，原有准入已恢复",
  };
  console.log(label[state.phase]);
  if (state.conversations.length > 0) {
    console.log(`本机对话：${state.conversations.join("、")}`);
  }
  for (const action of state.credentialActions) console.log(`下一步：${action}`);
}

async function requireConfirmation(
  io: DeviceRemovalSelectionIO,
  confirmed: boolean | undefined,
  message: string,
): Promise<void> {
  if (confirmed === true) return;
  if (!io.interactive) throw new TypeError("非交互环境必须同时提供 --confirm");
  if (!await io.confirm(message)) throw new Error("操作已取消");
}

function defaultSelectionIO(): DeviceRemovalSelectionIO {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const question = async (prompt: string): Promise<string> => {
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await reader.question(prompt)).trim();
    } finally {
      reader.close();
    }
  };
  return {
    interactive,
    async selectIndex(devices) {
      console.log("请选择要移除的设备：");
      devices.forEach((device, index) =>
        console.log(`${index + 1}. ${device.displayName}（${device.reachable ? "在线" : "离线"}）`));
      return Number(await question("序号：")) - 1;
    },
    async confirm(message) {
      return (await question(`${message} 输入“确认”继续：`)) === "确认";
    },
    async chooseMode(conversations) {
      console.log(`目标设备仍有 ${conversations.length} 个本机对话：${conversations.join("、")}`);
      const answer = await question("输入 1 收编到当前值班设备，2 永久删除，0 取消：");
      if (answer === "1") return "transfer";
      if (answer === "2") return "destroy";
      return "cancel";
    },
  };
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
