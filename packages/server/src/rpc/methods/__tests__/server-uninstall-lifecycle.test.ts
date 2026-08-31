import {
  createDeviceAdministrationProductApiContribution,
  DEVICE_ADMINISTRATION_PRODUCT_API_EXACT_SET,
  DeviceAdministrationApplicationService,
  type DeviceAdministrationCurrentRemovalMechanismPort,
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
  currentDeviceRemoval?: DeviceAdministrationCurrentRemovalMechanismPort,
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
          currentRemovalRecoveryBackup: {
            read: async () => ({
              state: "recoverable" as const,
              fullBackupReady: true,
              checkpointId: "checkpoint-1",
              targetId: "backup-target",
              upToLsn: 42,
            }),
          },
          currentDeviceRemoval,
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

function currentRemovalPort(): DeviceAdministrationCurrentRemovalMechanismPort & {
  readonly beginMigration: ReturnType<typeof vi.fn>;
  readonly beginRecoveryBackup: ReturnType<typeof vi.fn>;
  readonly continue: ReturnType<typeof vi.fn>;
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly status: ReturnType<typeof vi.fn>;
} {
  return {
    beginMigration: vi.fn(async () => ({ phase: "moving-duty-device" as const })),
    beginRecoveryBackup: vi.fn(async () => ({ phase: "backup-verified" as const })),
    continue: vi.fn(async () => ({ phase: "retiring-device" as const })),
    cancel: vi.fn(async () => ({ phase: "cancelled" as const })),
    status: vi.fn(async () => ({
      phase: "choose-safe-path" as const,
      nextAction: "choose-device" as const,
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
    }, ctx)).resolves.toEqual({ phase: "moving-duty-device" });
    await expect(buildAnchorUninstallContinueMethod().handler({
      operationId: "uninstall-local",
      confirmBackup: true,
      recoveryPackage: "recovery-package",
    }, ctx)).resolves.toEqual({ phase: "retiring-device" });
    await expect(buildAnchorUninstallCancelMethod().handler({
      operationId: "uninstall-local",
    }, ctx)).resolves.toEqual({ phase: "cancelled" });
    await expect(buildAnchorUninstallStatusMethod().handler({
      operationId: "uninstall-local",
    }, ctx)).resolves.toEqual({
      state: { phase: "choose-safe-path", nextAction: "choose-device" },
    });

    expect(port.beginMigration).toHaveBeenCalledWith({
      requestId: "request-uninstall",
      operationId: "uninstall-local",
      transferId: "transfer-local",
      targetDeviceId: "device-backup",
    });
    expect(port.continue).toHaveBeenCalledWith({
      operationId: "uninstall-local",
      confirmBackup: true,
      recoveryPackage: "recovery-package",
    });
    expect(port.cancel).toHaveBeenCalledWith({ operationId: "uninstall-local" });
    expect(port.status).toHaveBeenCalledWith({ operationId: "uninstall-local" });
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
