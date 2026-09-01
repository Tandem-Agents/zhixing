import {
  createDeviceAdministrationProductApiContribution,
  DEVICE_ADMINISTRATION_PRODUCT_API_EXACT_SET,
  DeviceAdministrationApplicationService,
} from "@zhixing/core/device-administration/application";
import { ProductApiDispatcher } from "@zhixing/core/product-api";
import { describe, expect, it, vi } from "vitest";
import type { HandlerContext } from "../../handlers.js";
import { RPC_ERROR_CODES } from "../../protocol.js";
import {
  buildAnchorUninstallBeginMethod,
  buildAnchorUninstallCancelMethod,
  buildAnchorUninstallContinueMethod,
  buildAnchorUninstallPreflightMethod,
  buildAnchorUninstallStatusMethod,
} from "../server.js";

function createProductApi(
  currentDeviceRemoval?: ReturnType<typeof currentRemovalPort>,
): ProductApiDispatcher {
  const application = new DeviceAdministrationApplicationService({
    relationships: { list: async () => [] },
    removalState: { read: async () => undefined },
    dutyMigrationTargets: { list: async () => [] },
    removalContext: {
      read: () => ({
        localDeviceId: "device-duty",
        currentDutyDeviceId: "device-duty",
        members: [],
      }),
    },
    removalAuthority: {
      acceptForTarget: async () => "accepted",
      operation: async () => undefined,
      operationForTarget: async () => undefined,
      abort: async () => "abort",
      commitLost: async () => undefined,
    },
    removalEffects: {
      isConnected: () => false,
      accept: async () => ({ conversations: [], hasAcceptedWork: false }),
      abort: async () => removalState("cancelled"),
      decide: async () => removalState("removed"),
    },
    dutyMigrationContext: {
      read: () => ({
        localDeviceId: "device-duty",
        currentDutyDeviceId: "device-duty",
        currentOwnerReady: true,
        deviceRemovalInProgress: false,
        members: [],
      }),
    },
    dutyMigration: {
      prepare: async () => undefined,
      commit: async () => undefined,
      cancel: async () => undefined,
    },
    ...(currentDeviceRemoval
      ? {
          currentRemovalContext: {
            read: async () => ({
              localDeviceId: "device-duty",
              currentDutyDeviceId: "device-duty",
              localIssuerKeyId: "key-duty",
              currentDutyIssuerKeyId: "key-duty",
              currentDeviceName: "当前设备",
              executorRemovalInProgress: false,
            }),
          },
          currentRemovalMigrationTargets: {
            list: async () => [{
              deviceId: "device-backup",
              displayName: "备用电脑",
              ready: true,
            }],
          },
          currentRemovalRecovery: {
            readiness: async () => ({
              state: "recoverable" as const,
              fullBackupReady: true,
              checkpointId: "checkpoint-1",
              targetId: "backup-target",
              upToLsn: 42,
            }),
            begin: currentDeviceRemoval.beginRecoveryBackup,
            confirm: currentDeviceRemoval.continue,
            resumeActive: async () => [],
          },
          currentRemovalMigration: {
            begin: currentDeviceRemoval.beginMigration,
            resumeActive: async () => [],
          },
          currentDeviceRemoval: {
            abort: currentDeviceRemoval.abort,
            read: currentDeviceRemoval.read,
          },
        }
      : {}),
  });
  return new ProductApiDispatcher(DEVICE_ADMINISTRATION_PRODUCT_API_EXACT_SET, [
    createDeviceAdministrationProductApiContribution(application),
  ]);
}

function context(input: {
  readonly loopback: boolean;
  readonly productApi?: ProductApiDispatcher;
}): HandlerContext {
  return {
    connection: { authenticated: true, loopback: input.loopback } as never,
    server: {
      config: { port: 18900, host: "127.0.0.1" },
      version: "test",
      startedAt: Date.now(),
      token: "token",
      ...(input.productApi ? { productApi: input.productApi } : {}),
    } as never,
  };
}

function currentRemovalPort(): {
  readonly beginMigration: ReturnType<typeof vi.fn>;
  readonly beginRecoveryBackup: ReturnType<typeof vi.fn>;
  readonly continue: ReturnType<typeof vi.fn>;
  readonly abort: ReturnType<typeof vi.fn>;
  readonly read: ReturnType<typeof vi.fn>;
} {
  return {
    beginMigration: vi.fn(async () => ({
      kind: "current-device-removal" as const,
      path: "migration" as const,
      phase: "gate-frozen" as const,
    })),
    beginRecoveryBackup: vi.fn(async () => ({
      kind: "current-device-removal" as const,
      path: "recovery-backup" as const,
      phase: "checkpoint-verified" as const,
    })),
    continue: vi.fn(async () => ({
      kind: "current-device-removal" as const,
      path: "recovery-backup" as const,
      phase: "retirement-decided" as const,
    })),
    abort: vi.fn(async () => ({
      kind: "current-device-removal" as const,
      path: "recovery-backup" as const,
      phase: "aborted" as const,
    })),
    read: vi.fn(async () => ({
      kind: "current-device-removal" as const,
      path: "recovery-backup" as const,
      phase: "accepted" as const,
    })),
  };
}

describe("anchor uninstall local lifecycle RPC", () => {
  it("rejects a non-loopback caller before invoking Product API", async () => {
    const port = currentRemovalPort();
    await expect(buildAnchorUninstallBeginMethod().handler({
      path: "recovery-backup",
      requestId: "request-uninstall",
      operationId: "uninstall-local",
    }, context({ loopback: false, productApi: createProductApi(port) })))
      .rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    expect(port.beginRecoveryBackup).not.toHaveBeenCalled();
  });

  it("dispatches all five wire operations through the shared Device application", async () => {
    const port = currentRemovalPort();
    const ctx = context({ loopback: true, productApi: createProductApi(port) });

    await expect(buildAnchorUninstallPreflightMethod().handler({}, ctx)).resolves.toEqual({
      currentDeviceName: "当前设备",
      migrationTargets: [{ displayName: "备用电脑", ready: true }],
      recoveryBackupReady: true,
    });
    await expect(buildAnchorUninstallBeginMethod().handler({
      path: "migration",
      requestId: "request-uninstall",
      operationId: "uninstall-local",
      transferId: "transfer-local",
      targetName: "备用电脑",
    }, ctx)).resolves.toEqual({
      phase: "moving-duty-device",
      nextAction: "continue",
    });
    await expect(buildAnchorUninstallContinueMethod().handler({
      operationId: "uninstall-local",
      confirmBackup: true,
      recoveryPackage: "recovery-package",
    }, ctx)).resolves.toEqual({
      phase: "retiring-device",
      nextAction: "continue",
    });
    await expect(buildAnchorUninstallCancelMethod().handler({
      operationId: "uninstall-local",
    }, ctx)).resolves.toEqual({ phase: "cancelled" });
    await expect(buildAnchorUninstallStatusMethod().handler({
      operationId: "uninstall-local",
    }, ctx)).resolves.toEqual({
      state: { phase: "choose-safe-path", nextAction: "continue" },
    });

    expect(port.beginMigration).toHaveBeenCalledWith({
      requestId: "request-uninstall",
      operationId: "uninstall-local",
      transferId: "transfer-local",
      targetDeviceId: "device-backup",
    });
    expect(port.continue).toHaveBeenCalledWith({
      operationId: "uninstall-local",
      recoveryPackage: "recovery-package",
    });
    expect(port.abort).toHaveBeenCalledWith({ operationId: "uninstall-local" });
    expect(port.read).toHaveBeenCalledWith({ operationId: "uninstall-local" });
  });

  it("requires explicit backup confirmation before the application command", async () => {
    const port = currentRemovalPort();
    await expect(buildAnchorUninstallContinueMethod().handler({
      operationId: "uninstall-local",
      confirmBackup: false,
    }, context({ loopback: true, productApi: createProductApi(port) })))
      .rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    expect(port.continue).not.toHaveBeenCalled();
  });

  it("projects raw status and rejects an irreversible cancellation before abort", async () => {
    const port = currentRemovalPort();
    const ctx = context({ loopback: true, productApi: createProductApi(port) });
    port.read.mockResolvedValueOnce({
      kind: "current-device-removal",
      path: "recovery-backup",
      phase: "checkpoint-verified",
    });
    await expect(buildAnchorUninstallStatusMethod().handler({
      operationId: "uninstall-local",
    }, ctx)).resolves.toEqual({
      state: { phase: "backup-verified", nextAction: "confirm-backup" },
    });

    port.read.mockResolvedValueOnce({
      kind: "current-device-removal",
      path: "migration",
      phase: "transfer-committed",
    });
    await expect(buildAnchorUninstallCancelMethod().handler({
      operationId: "uninstall-local",
    }, ctx)).rejects.toMatchObject({
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
      message: "永久卸载尚未完成；安全进度已保留，请使用同一操作继续",
    });
    expect(port.abort).not.toHaveBeenCalled();
  });

  it("fails closed when Product API or the mechanism contribution is unavailable", async () => {
    await expect(buildAnchorUninstallPreflightMethod().handler({}, context({ loopback: true })))
      .rejects.toMatchObject({
        code: RPC_ERROR_CODES.INTERNAL_ERROR,
        message: "当前设备不支持永久卸载",
      });
    await expect(buildAnchorUninstallPreflightMethod().handler(
      {},
      context({ loopback: true, productApi: createProductApi() }),
    )).rejects.toMatchObject({
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
      message: "当前设备不支持永久卸载",
    });
  });

  it("preserves the established current-removal error mapping", async () => {
    const port = currentRemovalPort();
    port.beginMigration.mockRejectedValueOnce(new Error("target is not ready"));
    await expect(buildAnchorUninstallBeginMethod().handler({
      path: "migration",
      requestId: "request-uninstall",
      operationId: "uninstall-local",
      transferId: "transfer-local",
      targetName: "备用电脑",
    }, context({ loopback: true, productApi: createProductApi(port) })))
      .rejects.toMatchObject({
        code: RPC_ERROR_CODES.INTERNAL_ERROR,
        message: "请先选择可用的值班设备，或验证恢复备份后再继续",
      });
  });
});

function removalState(phase: "cancelled" | "removed") {
  return {
    phase,
    conversations: [],
    localData: "known" as const,
    credentialActions: [],
  };
}
