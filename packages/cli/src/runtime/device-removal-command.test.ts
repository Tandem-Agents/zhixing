import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcManagementFacade } from "./rpc-management-facade.js";
import {
  selectRemovalTarget,
  removeDeviceWithManagement,
  type DeviceRemovalSelectionIO,
} from "./device-removal-command.js";

const nonInteractive: DeviceRemovalSelectionIO = {
  interactive: false,
  selectIndex: async () => -1,
  confirm: async () => false,
  chooseMode: async () => "cancel",
};

afterEach(() => vi.restoreAllMocks());

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

describe("durable device removal cancellation", () => {
  it("writes an exact durable cancel when confirmation is rejected after accept", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const deviceContinue = vi.fn(async () => cancelled());
    const management = {
      deviceList: async () => [{ displayName: "旅行电脑", reachable: true }],
      deviceRemove: async () => ({ conversations: ["本机对话"], hasAcceptedWork: true }),
      deviceContinue,
    } as unknown as Pick<RpcManagementFacade, "deviceList" | "deviceRemove" | "deviceContinue">;
    await removeDeviceWithManagement(management, {
      permanent: true,
      targetName: "旅行电脑",
      mode: "destroy",
    }, {
      ...nonInteractive,
      interactive: true,
      confirm: async () => false,
    });
    expect(deviceContinue).toHaveBeenCalledOnce();
    expect(deviceContinue).toHaveBeenCalledWith(expect.objectContaining({
      targetName: "旅行电脑",
      mode: "cancel",
      operationId: expect.stringMatching(/^remove-/u),
    }));
  });

  it("confirms lost-device revocation before any irreversible decision", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const deviceContinue = vi.fn(async () => cancelled());
    const management = {
      deviceList: async () => [{ displayName: "旅行电脑", reachable: false }],
      deviceRemove: async () => ({ conversations: [], hasAcceptedWork: false }),
      deviceContinue,
    } as unknown as Pick<RpcManagementFacade, "deviceList" | "deviceRemove" | "deviceContinue">;
    await removeDeviceWithManagement(management, {
      permanent: true,
      targetName: "旅行电脑",
      mode: "lost",
    }, {
      ...nonInteractive,
      interactive: true,
      confirm: async () => false,
    });
    expect(deviceContinue.mock.calls).toHaveLength(1);
    expect(deviceContinue.mock.calls[0]?.[0]).toMatchObject({ mode: "cancel" });
  });

  it("retries the same exact cancel when accept or abort responses are lost", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const deviceContinue = vi.fn()
      .mockRejectedValueOnce(new Error("abort response lost"))
      .mockResolvedValueOnce(cancelled());
    const deviceRemove = vi.fn(async () => {
      throw new Error("accept response lost");
    });
    const management = {
      deviceList: async () => [{ displayName: "旅行电脑", reachable: true }],
      deviceRemove,
      deviceContinue,
    } as unknown as Pick<RpcManagementFacade, "deviceList" | "deviceRemove" | "deviceContinue">;
    await expect(removeDeviceWithManagement(management, {
      permanent: true,
      targetName: "旅行电脑",
      mode: "transfer",
      confirmed: true,
    }, nonInteractive)).rejects.toThrow("accept response lost");
    expect(deviceContinue).toHaveBeenCalledTimes(2);
    expect(deviceContinue.mock.calls[0]?.[0]).toEqual(deviceContinue.mock.calls[1]?.[0]);
    expect(deviceContinue.mock.calls[0]?.[0]).toMatchObject({
      mode: "cancel",
      operationId: expect.stringMatching(/^remove-/u),
    });
  });
});

function cancelled() {
  return {
    phase: "cancelled" as const,
    conversations: [],
    localData: "known" as const,
    credentialActions: [],
  };
}
