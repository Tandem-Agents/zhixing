import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcManagementFacade } from "./rpc-management-facade.js";
import {
  continueDeviceRemovalWithManagement,
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
      deviceStatus: async () => null,
    } as unknown as Pick<
      RpcManagementFacade,
      "deviceList" | "deviceRemove" | "deviceContinue" | "deviceStatus"
    >;
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
      deviceStatus: async () => null,
    } as unknown as Pick<
      RpcManagementFacade,
      "deviceList" | "deviceRemove" | "deviceContinue" | "deviceStatus"
    >;
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
      deviceStatus: async () => null,
    } as unknown as Pick<
      RpcManagementFacade,
      "deviceList" | "deviceRemove" | "deviceContinue" | "deviceStatus"
    >;
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

describe("device removal decision failure projection", () => {
  it("renders the durable decided state after a lost decision response", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const deviceStatus = vi.fn(async () => state("moving-conversations"));
    const management = {
      deviceContinue: vi.fn(async () => { throw new Error("raw response loss"); }),
      deviceStatus,
    } as unknown as Pick<RpcManagementFacade, "deviceContinue" | "deviceStatus">;

    await continueDeviceRemovalWithManagement(management, {
      targetName: "旅行电脑",
      mode: "transfer",
    }, true);

    expect(deviceStatus).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith("正在收束目标设备上的本机对话");
  });

  it("gives exact continue-or-cancel actions while the durable operation is still pending", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const management = {
      deviceContinue: vi.fn(async () => { throw new Error("decision rejected"); }),
      deviceStatus: vi.fn(async () => state("needs-conversation-decision")),
    } as unknown as Pick<RpcManagementFacade, "deviceContinue" | "deviceStatus">;

    await continueDeviceRemovalWithManagement(management, {
      targetName: "旅行电脑",
      mode: "destroy",
    }, true);

    expect(output).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledWith(
      "移除已登记，但处理方式尚未确认。请运行 `zz device continue <设备名称> --mode destroy` 继续，" +
        "或将 mode 改为 cancel 取消；<设备名称> 填写“旅行电脑”。",
    );
    expect(management.deviceContinue).toHaveBeenCalledOnce();
  });

  it("replaces raw decision and status failures with one stable action", async () => {
    const management = {
      deviceContinue: vi.fn(async () => { throw new Error("raw decision failure"); }),
      deviceStatus: vi.fn(async () => { throw new Error("raw status failure"); }),
    } as unknown as Pick<RpcManagementFacade, "deviceContinue" | "deviceStatus">;

    await expect(continueDeviceRemovalWithManagement(management, {
      targetName: "旅行电脑",
      mode: "lost",
    }, false)).rejects.toThrow(
      "设备移除状态暂时无法确认。请稍后运行 `zz device status <设备名称>` 查看进度；" +
        "<设备名称> 填写“旅行电脑”。",
    );
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

function state(phase: "needs-conversation-decision" | "moving-conversations") {
  return {
    phase,
    conversations: [],
    localData: "known" as const,
    credentialActions: [],
  };
}
