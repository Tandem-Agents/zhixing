import { describe, expect, it, vi } from "vitest";
import {
  renderUninstallState,
  selectPath,
  type AnchorUninstallIO,
} from "./anchor-uninstall-command.js";

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
