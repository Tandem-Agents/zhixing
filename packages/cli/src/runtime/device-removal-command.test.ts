import { describe, expect, it } from "vitest";
import type { RpcManagementFacade } from "./rpc-management-facade.js";
import {
  selectRemovalTarget,
  type DeviceRemovalSelectionIO,
} from "./device-removal-command.js";

const nonInteractive: DeviceRemovalSelectionIO = {
  interactive: false,
  selectIndex: async () => -1,
  confirm: async () => false,
  chooseMode: async () => "cancel",
};

describe("device removal selection", () => {
  it("uses the unique display name and keeps internal device identities out of the command", async () => {
    const management = {
      deviceList: async () => [
        { displayName: "工作电脑", reachable: true },
        { displayName: "旅行电脑", reachable: false },
      ],
    } as Pick<RpcManagementFacade, "deviceList">;
    await expect(selectRemovalTarget(management, "旅行电脑", nonInteractive))
      .resolves.toEqual({ displayName: "旅行电脑", reachable: false });
    await expect(selectRemovalTarget(management, undefined, nonInteractive))
      .rejects.toThrow("必须提供唯一的设备名称");
  });

  it("rejects duplicate and unknown names deterministically", async () => {
    const duplicate = {
      deviceList: async () => [
        { displayName: "电脑", reachable: true },
        { displayName: "电脑", reachable: false },
      ],
    } as Pick<RpcManagementFacade, "deviceList">;
    await expect(selectRemovalTarget(duplicate, "电脑", nonInteractive))
      .rejects.toThrow("多个名为");
    await expect(selectRemovalTarget(duplicate, "不存在", nonInteractive))
      .rejects.toThrow("没有名为");
  });
});
