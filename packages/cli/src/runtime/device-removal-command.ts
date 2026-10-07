import { getZhixingHome } from "@zhixing/core/paths";
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

export type DeviceRemovalManagement = Pick<RpcManagementFacade,
  "deviceList" | "deviceRemove" | "deviceContinue" | "deviceStatus">;

export interface DeviceRemovalCommandOptions {
  /** Borrowed from the caller; this command never ensures or disposes it. */
  readonly management?: DeviceRemovalManagement;
  readonly writeLine?: (line: string) => void;
  readonly signal?: AbortSignal;
}

export async function listRemovableDevices(options: DeviceRemovalCommandOptions = {}): Promise<void> {
  const writeLine = options.writeLine ?? console.log;
  await withManagement(async (management) => {
    const devices = await management.deviceList();
    if (devices.length === 0) {
      writeLine("当前没有可移除的已配对设备。");
      return;
    }
    writeLine("已配对设备：");
    for (const device of devices) {
      writeLine(`- ${device.displayName}：${device.reachable ? "在线" : "当前离线"}`);
    }
  }, options);
}

export async function removeDevice(input: {
  readonly targetName?: string;
  readonly mode?: Exclude<DeviceRemovalMode, "cancel">;
  readonly confirmed?: boolean;
  readonly permanent?: boolean;
}, io?: DeviceRemovalSelectionIO, options: DeviceRemovalCommandOptions = {}): Promise<void> {
  if (input.permanent !== true) {
    throw new TypeError("永久移除设备必须显式提供 --permanent");
  }
  await withManagement((management) => removeDeviceWithManagement(management, input,
    io ?? defaultSelectionIO(options.writeLine, options.signal), options), options);
}

export async function removeDeviceWithManagement(
  management: Pick<
    RpcManagementFacade,
    "deviceList" | "deviceRemove" | "deviceContinue" | "deviceStatus"
  >,
  input: {
    readonly targetName?: string;
    readonly mode?: Exclude<DeviceRemovalMode, "cancel">;
    readonly confirmed?: boolean;
    readonly permanent?: boolean;
  },
  io: DeviceRemovalSelectionIO,
  options: Pick<DeviceRemovalCommandOptions, "writeLine" | "signal"> = {},
): Promise<void> {
    options.signal?.throwIfAborted();
    const writeLine = options.writeLine ?? console.log;
    const device = await selectRemovalTarget(management, input.targetName, io);
    options.signal?.throwIfAborted();
    const operationId = createDeviceRemovalOperationId();
    const requestId = `request:${operationId}`;
    let acceptStarted = false;
    let irreversibleDecisionStarted = false;
    try {
      acceptStarted = true;
      const preflight = await management.deviceRemove({
        requestId,
        operationId,
        targetName: device.displayName,
      });
      writeLine(`“${device.displayName}”的移除操作已安全登记。`);
      options.signal?.throwIfAborted();
      let mode: DeviceRemovalMode | undefined = input.mode;
      if (!mode) {
        mode = preflight.conversations.length === 0
          ? "transfer"
          : io.interactive
            ? await io.chooseMode(preflight.conversations)
            : undefined;
      }
      options.signal?.throwIfAborted();
      if (!mode) {
        throw new TypeError("非交互环境必须用 --mode transfer、--mode destroy 或 --mode lost 明确处理方式");
      }
      if (mode === "cancel") {
        renderState(await cancelAcceptedRemoval(management, device.displayName, operationId), writeLine);
        return;
      }
      const work = preflight.conversations.length === 0
        ? "没有未转移的本机对话"
        : `未转移的本机对话：${preflight.conversations.join("、")}`;
      const consequence = mode === "destroy"
        ? "这些本机数据将永久删除，无法恢复"
        : mode === "lost"
          ? "只会撤销访问，目标设备上的本机数据无法验证或擦除"
          : "本机工作收束后将永久撤销该设备的访问";
      await requireConfirmation(
        io,
        input.confirmed,
        `永久移除设备“${device.displayName}”。${work}；${consequence}。继续吗？`,
      );
      options.signal?.throwIfAborted();
      irreversibleDecisionStarted = true;
      await continueDeviceRemovalWithManagement(management, {
        targetName: device.displayName,
        mode,
      }, true, options);
    } catch (error) {
      if (acceptStarted && !irreversibleDecisionStarted) {
        try {
          const cancelled = await cancelAcceptedRemoval(
            management,
            device.displayName,
            operationId,
          );
          if (error instanceof DeviceRemovalCancelled) {
            renderState(cancelled, writeLine);
            return;
          }
        } catch (cancelError) {
          throw new AggregateError(
            [error, cancelError],
            "设备移除尚未继续，但取消状态暂时无法确认；请使用同一设备和操作重试",
          );
        }
      }
      throw error;
    }
}

export async function continueDeviceRemoval(input: {
  readonly targetName: string;
  readonly mode: DeviceRemovalMode;
  readonly confirmed?: boolean;
}, io?: DeviceRemovalSelectionIO, options: DeviceRemovalCommandOptions = {}): Promise<void> {
  options.signal?.throwIfAborted();
  const selection = io ?? defaultSelectionIO(options.writeLine, options.signal);
  const writeLine = options.writeLine ?? console.log;
  if (input.mode === "destroy" || input.mode === "lost") {
    await requireConfirmation(
      selection,
      input.confirmed,
      input.mode === "lost"
        ? "目标设备本地数据仍不可验证或擦除；只撤销访问。继续吗？"
        : "该操作会永久删除目标设备上的本地权威数据。继续吗？",
    );
  }
  await withManagement(async (management) => {
    if (input.mode === "cancel") {
      renderState(await management.deviceContinue(input), writeLine);
      return;
    }
    await continueDeviceRemovalWithManagement(management, {
      targetName: input.targetName,
      mode: input.mode,
    }, false, options);
  }, options);
}

export async function continueDeviceRemovalWithManagement(
  management: Pick<RpcManagementFacade, "deviceContinue" | "deviceStatus">,
  input: {
    readonly targetName: string;
    readonly mode: Exclude<DeviceRemovalMode, "cancel">;
  },
  knownAccepted: boolean,
  options: Pick<DeviceRemovalCommandOptions, "writeLine" | "signal"> = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  const writeLine = options.writeLine ?? console.log;
  try {
    renderState(await management.deviceContinue(input), writeLine);
    return;
  } catch {
    await renderDecisionDispatchFailure(management, input.targetName, input.mode, knownAccepted, writeLine);
  }
}

export async function showDeviceRemovalStatus(
  targetName: string,
  options: DeviceRemovalCommandOptions = {},
): Promise<void> {
  const writeLine = options.writeLine ?? console.log;
  await withManagement(async (management) => {
    const state = await management.deviceStatus({ targetName });
    if (!state) {
      writeLine("没有找到该设备移除操作。");
      return;
    }
    renderState(state, writeLine);
  }, options);
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

function renderState(state: DeviceRemovalState, writeLine: (line: string) => void): void {
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
  writeLine(label[state.phase]);
  if (state.conversations.length > 0) {
    writeLine(`本机对话：${state.conversations.join("、")}`);
  }
  for (const action of state.credentialActions) writeLine(`下一步：${action}`);
}

async function renderDecisionDispatchFailure(
  management: Pick<RpcManagementFacade, "deviceStatus">,
  targetName: string,
  mode: Exclude<DeviceRemovalMode, "cancel">,
  knownAccepted: boolean,
  writeLine: (line: string) => void,
): Promise<void> {
  let state: DeviceRemovalState | null;
  try {
    state = await management.deviceStatus({ targetName });
  } catch {
    throw new Error(
      `设备移除状态暂时无法确认。请稍后运行 \`zz device status <设备名称>\` 查看进度；` +
        `<设备名称> 填写“${targetName}”。`,
    );
  }
  if (!state) {
    if (knownAccepted) {
      renderPendingDecisionAction(targetName, mode, writeLine);
      return;
    }
    throw new Error(
      `没有找到可继续的设备移除操作。请重新运行 ` +
        `\`zz device remove <设备名称> --permanent --mode ${mode}\`；` +
        `<设备名称> 填写“${targetName}”。`,
    );
  }
  if (
    state.phase === "waiting-for-device" ||
    state.phase === "needs-conversation-decision"
  ) {
    renderPendingDecisionAction(targetName, mode, writeLine);
    return;
  }
  renderState(state, writeLine);
}

function renderPendingDecisionAction(
  targetName: string,
  mode: Exclude<DeviceRemovalMode, "cancel">,
  writeLine: (line: string) => void,
): void {
  writeLine(
    `移除已登记，但处理方式尚未确认。请运行 ` +
      `\`zz device continue <设备名称> --mode ${mode}\` 继续，` +
      `或将 mode 改为 cancel 取消；<设备名称> 填写“${targetName}”。`,
  );
}

async function requireConfirmation(
  io: DeviceRemovalSelectionIO,
  confirmed: boolean | undefined,
  message: string,
): Promise<void> {
  if (confirmed === true) return;
  if (!io.interactive) throw new TypeError("非交互环境必须同时提供 --confirm");
  if (!await io.confirm(message)) throw new DeviceRemovalCancelled();
}

class DeviceRemovalCancelled extends Error {
  constructor() {
    super("操作已取消");
    this.name = "DeviceRemovalCancelled";
  }
}

async function cancelAcceptedRemoval(
  management: Pick<RpcManagementFacade, "deviceContinue">,
  targetName: string,
  operationId: string,
): Promise<DeviceRemovalState> {
  let firstError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await management.deviceContinue({
        targetName,
        operationId,
        mode: "cancel",
      });
    } catch (error) {
      firstError ??= error;
    }
  }
  throw firstError;
}

function defaultSelectionIO(writeLine: (line: string) => void = console.log, signal?: AbortSignal): DeviceRemovalSelectionIO {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const question = async (prompt: string): Promise<string> => {
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await reader.question(prompt, { signal })).trim();
    } finally {
      reader.close();
    }
  };
  return {
    interactive,
    async selectIndex(devices) {
      writeLine("请选择要移除的设备：");
      devices.forEach((device, index) =>
        writeLine(`${index + 1}. ${device.displayName}（${device.reachable ? "在线" : "离线"}）`));
      return Number(await question("序号：")) - 1;
    },
    async confirm(message) {
      return (await question(`${message} 输入“确认”继续：`)) === "确认";
    },
    async chooseMode(conversations) {
      writeLine(`目标设备仍有 ${conversations.length} 个本机对话：${conversations.join("、")}`);
      const answer = await question("输入 1 收编到当前值班设备，2 永久删除，0 取消：");
      if (answer === "1") return "transfer";
      if (answer === "2") return "destroy";
      return "cancel";
    },
  };
}

async function withManagement<T>(
  operation: (management: DeviceRemovalManagement) => Promise<T>,
  options: DeviceRemovalCommandOptions,
): Promise<T> {
  options.signal?.throwIfAborted();
  if (options.management) return operation(options.management);
  const coreHost = new CoreHostConnection(defaultCoreHostConnectionDeps(getZhixingHome()));
  try {
    await coreHost.ensure();
    options.signal?.throwIfAborted();
    return await operation(new RpcManagementFacade(coreHost));
  } finally {
    await coreHost.dispose();
  }
}
