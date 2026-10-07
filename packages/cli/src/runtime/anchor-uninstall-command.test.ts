import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreHostConnection } from "./core-host-connection.js";
import {
  renderUninstallState,
  selectPath,
  uninstallCurrentDevice,
  type AnchorUninstallIO,
  type AnchorUninstallManagement,
} from "./anchor-uninstall-command.js";

afterEach(() => vi.restoreAllMocks());

const nonInteractive: AnchorUninstallIO = {
  interactive: false,
  choosePath: async () => {
    throw new Error("unexpected interactive selection");
  },
  confirm: async () => false,
  readRecoveryPackage: async () => {
    throw new Error("unexpected recovery package input");
  },
};

describe("borrowed current-device uninstall", () => {
  it("retains both confirmations and the actual recovery read without owning the caller connection", async () => {
    const ensure = vi.spyOn(CoreHostConnection.prototype, "ensure").mockRejectedValue(new Error("unexpected Host"));
    const dispose = vi.spyOn(CoreHostConnection.prototype, "dispose").mockResolvedValue(undefined);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const management = uninstallManagement();
    const lines: string[] = [];
    const confirm = vi.fn(async () => true);
    const readRecoveryPackage = vi.fn(async () => "secret-recovery-readback");
    await uninstallCurrentDevice({}, {
      ...nonInteractive, interactive: true, confirm, readRecoveryPackage,
      choosePath: async () => ({ path: "recovery-backup" }),
    }, { management, writeLine: (line) => lines.push(line) });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(readRecoveryPackage).toHaveBeenCalledOnce();
    const begin = management.anchorUninstallBegin.mock.calls[0]![0];
    expect(begin).toMatchObject({ path: "recovery-backup", recoveryPackage: "secret-recovery-readback" });
    expect(management.anchorUninstallContinue).toHaveBeenCalledWith({
      operationId: begin.operationId, confirmBackup: true, recoveryPackage: "secret-recovery-readback",
    });
    expect(lines).toEqual(["这台设备已永久卸载"]);
    expect(stdout).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("does not turn a cancelled final confirmation into uninstall or roll back the verified backup", async () => {
    const management = uninstallManagement();
    const confirm = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(uninstallCurrentDevice({ recoveryBackup: true }, {
      ...nonInteractive, interactive: true, confirm, readRecoveryPackage: async () => "secret",
    }, { management, writeLine: () => undefined })).rejects.toThrow("操作已取消");
    expect(management.anchorUninstallBegin).toHaveBeenCalledOnce();
    expect(management.anchorUninstallContinue).not.toHaveBeenCalled();
  });

  it("rejects a closed secret reader before beginning uninstall", async () => {
    const management = uninstallManagement();
    const abort = new AbortController();
    await expect(uninstallCurrentDevice({ recoveryBackup: true, confirmed: true }, {
      ...nonInteractive,
      readRecoveryPackage: async () => { abort.abort(); return "secret"; },
    }, { management, signal: abort.signal, writeLine: () => undefined })).rejects.toThrow();
    expect(management.anchorUninstallBegin).not.toHaveBeenCalled();
    expect(management.anchorUninstallContinue).not.toHaveBeenCalled();
  });

  it("uses the original migration path without opening the recovery reader", async () => {
    const management = uninstallManagement();
    management.anchorUninstallBegin.mockResolvedValue({ phase: "moving-duty-device" });
    const lines: string[] = [];
    await uninstallCurrentDevice({ targetName: "接班电脑", confirmed: true }, nonInteractive, {
      management, writeLine: (line) => lines.push(line),
    });
    expect(management.anchorUninstallBegin).toHaveBeenCalledWith(expect.objectContaining({
      path: "migration", targetName: "接班电脑", transferId: expect.stringMatching(/^transfer-/u),
    }));
    expect(management.anchorUninstallContinue).not.toHaveBeenCalled();
    expect(lines).toEqual(["正在把值班职责交给另一台设备"]);
  });
});

function uninstallManagement() {
  return {
    anchorUninstallPreflight: vi.fn<AnchorUninstallManagement["anchorUninstallPreflight"]>(async () => ({
      currentDeviceName: "当前电脑", recoveryBackupReady: true,
      migrationTargets: [{ displayName: "接班电脑", ready: true }],
    })),
    anchorUninstallBegin: vi.fn<AnchorUninstallManagement["anchorUninstallBegin"]>(async () => ({ phase: "backup-verified" })),
    anchorUninstallContinue: vi.fn<AnchorUninstallManagement["anchorUninstallContinue"]>(async () => ({ phase: "uninstalled" })),
  };
}

describe("anchor uninstall command projection", () => {
  it("selects only a unique ready device name and never accepts an unavailable target", async () => {
    const preflight = {
      currentDeviceName: "当前电脑",
      migrationTargets: [
        { displayName: "书房电脑", ready: true },
        { displayName: "离线电脑", ready: false },
      ],
      recoveryBackupReady: true,
    };
    await expect(selectPath(preflight, { targetName: "书房电脑" }, nonInteractive))
      .resolves.toEqual({ path: "migration", targetName: "书房电脑" });
    await expect(selectPath(preflight, { targetName: "离线电脑" }, nonInteractive))
      .rejects.toThrow("没有名为");
    await expect(selectPath({
      ...preflight,
      migrationTargets: [
        { displayName: "电脑", ready: true },
        { displayName: "电脑", ready: true },
      ],
    }, { targetName: "电脑" }, nonInteractive)).rejects.toThrow("多个名为");
  });

  it("requires an explicit safe path outside a terminal and projects only action language", async () => {
    await expect(selectPath({
      currentDeviceName: "当前电脑",
      migrationTargets: [],
      recoveryBackupReady: false,
    }, {}, nonInteractive))
      .rejects.toThrow("非交互环境必须提供");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      renderUninstallState({ phase: "backup-verified", nextAction: "confirm-backup" });
      expect(log).toHaveBeenCalledWith("恢复备份已验证，等待最终确认");
      expect(log.mock.calls.flat().join(" ")).not.toMatch(/operation|epoch|digest|[A-Za-z]:\\/u);
    } finally {
      log.mockRestore();
    }
  });
});
