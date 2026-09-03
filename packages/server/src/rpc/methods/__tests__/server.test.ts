import { describe, it, expect, vi } from "vitest";
import type { ExecutionStatusNotice } from "@zhixing/core/contracts";
import {
  createDeliveryResolutionProductApiContribution,
  DELIVERY_RESOLUTION_PRODUCT_API_EXACT_SET,
  type DeliveryUncertainResolutionApplication,
} from "@zhixing/core/delivery/application";
import {
  createDeviceAdministrationProductApiContribution,
  DEVICE_ADMINISTRATION_PRODUCT_API_EXACT_SET,
  DeviceAdministrationApplicationService,
  type DeviceAdministrationApplicationOptions,
} from "@zhixing/core/device-administration/application";
import {
  createScheduleRuntimeProductApiContribution,
  SCHEDULE_RUNTIME_PRODUCT_API_EXACT_SET,
} from "@zhixing/core/scheduler/application";
import { ProductApiDispatcher } from "@zhixing/core/product-api";
import type { RuntimeControlAdapter } from "../../../context.js";
import {
  buildServerShutdownMethod,
  buildServerInfoMethod,
  buildDeliveryResolveMethod,
  buildDutyMigrationCancelMethod,
  buildDutyMigrationCommitMethod,
  buildDutyMigrationPrepareMethod,
  buildDutyMigrationTargetsMethod,
  buildDeviceListMethod,
  buildDeviceContinueMethod,
  buildDeviceRemoveMethod,
  buildDeviceStatusMethod,
  buildAnchorUninstallBeginMethod,
  buildAnchorUninstallCancelMethod,
  buildAnchorUninstallContinueMethod,
  buildAnchorUninstallPreflightMethod,
  buildAnchorUninstallStatusMethod,
  buildLlmCompleteMethod,
} from "../server.js";
import type { HandlerContext } from "../../handlers.js";
import { HandlerRegistry, RpcAppError } from "../../handlers.js";
import { RPC_ERROR_CODES } from "../../protocol.js";
import { RpcDispatcher } from "../../dispatcher.js";

function mkCtx(overrides: Partial<HandlerContext["server"]> = {}): HandlerContext {
  return {
    connection: { authenticated: true, loopback: true } as any,
    server: {
      config: { port: 18900, host: "127.0.0.1" } as any,
      version: "0.1.0-test",
      startedAt: Date.now() - 1000,
      token: "t",
      ...overrides,
    } as any,
  };
}

function deviceAdministrationProductApi(
  overrides: Partial<DeviceAdministrationApplicationOptions<string, string>> = {},
): ProductApiDispatcher {
  const application = new DeviceAdministrationApplicationService({
    relationships: { list: async () => [] },
    removalState: { read: async () => undefined },
    dutyMigrationTargets: { list: async () => [] },
    removalContext: {
      read: () => ({
        localDeviceId: "device-duty",
        currentDutyDeviceId: "device-duty",
        members: [{
          deviceId: "device-target",
          displayName: "设备",
          state: "active",
        }],
      }),
    },
    removalAuthority: {
      acceptForTarget: async () => "accepted-token",
      operation: async (operationId) => ({ operationId, targetDeviceId: "device-target" }),
      operationForTarget: async () => ({
        operationId: "operation-1",
        targetDeviceId: "device-target",
      }),
      abort: async () => "abort-token",
      commitLost: async () => undefined,
    },
    removalEffects: {
      accept: async () => ({
        kind: "completed",
        result: { conversations: [], hasAcceptedWork: false },
      }),
      abort: async () => ({
        kind: "completed",
        result: {
          phase: "cancelled",
          conversations: [],
          localData: "known",
          credentialActions: [],
        },
      }),
      decide: async () => ({
        kind: "completed",
        result: {
          phase: "removed",
          conversations: [],
          localData: "removed",
          credentialActions: [],
        },
      }),
    },
    dutyMigrationContext: {
      read: () => ({
        localDeviceId: "device-duty",
        currentDutyDeviceId: "device-duty",
        currentOwnerReady: true,
        deviceRemovalInProgress: false,
        members: [{
          deviceId: "device-target",
          state: "active",
          dutyCapable: true,
        }],
      }),
    },
    dutyMigration: {
      prepare: async () => undefined,
      commit: async () => undefined,
      cancel: async () => undefined,
    },
    ...overrides,
  });
  return new ProductApiDispatcher(DEVICE_ADMINISTRATION_PRODUCT_API_EXACT_SET, [
    createDeviceAdministrationProductApiContribution(application),
  ]);
}

describe("Device Administration command Product API input", () => {
  it.each([
    [buildDeviceRemoveMethod, { requestId: "request-1", operationId: "operation-1", targetName: "设备", extra: true }],
    [buildDeviceContinueMethod, { targetName: "设备", mode: "destroy", extra: true }],
    [buildDeviceStatusMethod, { targetName: "设备", extra: true }],
  ] as const)("rejects unknown device fields before lifecycle effects", async (build, params) => {
    const entry = build();
    await expect(entry.handler(params, mkCtx({
      productApi: deviceAdministrationProductApi(),
    })))
      .rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
  });

  it("accepts operationId only for exact cancel and forwards the complete identity", async () => {
    const operation = vi.fn(async (operationId: string) => ({
      operationId,
      targetDeviceId: "device-target",
    }));
    const entry = buildDeviceContinueMethod();
    const ctx = mkCtx({
      productApi: deviceAdministrationProductApi({
        removalAuthority: {
          acceptForTarget: async () => "accepted-token",
          operation,
          operationForTarget: async () => undefined,
          abort: async () => "abort-token",
          commitLost: async () => undefined,
        },
      }),
    });
    await expect(entry.handler({
      targetName: "设备",
      operationId: "operation-1",
      mode: "cancel",
    }, ctx)).resolves.toEqual({
      phase: "cancelled",
      conversations: [],
      localData: "known",
      credentialActions: [],
    });
    expect(operation).toHaveBeenCalledWith("operation-1");
    await expect(entry.handler({
      targetName: "设备",
      operationId: "operation-1",
      mode: "destroy",
    }, ctx)).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("dispatches remove through the shared application and preserves lifecycle errors", async () => {
    const acceptForTarget = vi.fn(async () => "accepted-token");
    const accept = vi.fn(async () => ({
      kind: "completed" as const,
      result: {
        conversations: ["conv-main"],
        hasAcceptedWork: true,
      },
    }));
    const ctx = mkCtx({
      productApi: deviceAdministrationProductApi({
        removalAuthority: {
          acceptForTarget,
          operation: async () => undefined,
          operationForTarget: async () => undefined,
          abort: async () => "abort-token",
          commitLost: async () => undefined,
        },
        removalEffects: {
          accept,
          abort: async () => {
            throw new Error("unexpected abort");
          },
          decide: async () => {
            throw new Error("unexpected decide");
          },
        },
      }),
    });
    await expect(buildDeviceRemoveMethod().handler({
      requestId: "request-1",
      operationId: "operation-1",
      targetName: "设备",
    }, ctx)).resolves.toEqual({
      conversations: ["conv-main"],
      hasAcceptedWork: true,
    });
    expect(acceptForTarget).toHaveBeenCalledWith({
      requestId: "request-1",
      operationId: "operation-1",
      targetDeviceId: "device-target",
    });
    expect(accept).toHaveBeenCalledWith({
      targetDeviceId: "device-target",
      accepted: "accepted-token",
    });

    await expect(buildDeviceContinueMethod().handler({
      targetName: "设备",
      mode: "transfer",
    }, mkCtx({
      productApi: deviceAdministrationProductApi({
        removalEffects: {
          accept,
          abort: async () => {
            throw new Error("unexpected abort");
          },
          decide: async () => ({ kind: "unavailable" }),
        },
      }),
    }))).rejects.toMatchObject({
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
      message: "目标设备当前离线：可以等待它重新上线，或明确按失控设备撤销",
    });
  });

  it("fails closed when the Host has no device removal command contribution", async () => {
    await expect(buildDeviceRemoveMethod().handler({
      requestId: "request-1",
      operationId: "operation-1",
      targetName: "设备",
    }, mkCtx())).rejects.toMatchObject({
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
      message: "设备管理当前不可用",
    });
    await expect(buildDeviceContinueMethod().handler({
      targetName: "设备",
      mode: "lost",
    }, mkCtx())).rejects.toMatchObject({
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
      message: "设备管理当前不可用",
    });
  });

  it.each([
    [buildAnchorUninstallPreflightMethod, { extra: true }],
    [buildAnchorUninstallBeginMethod, {
      path: "migration", requestId: "request-1", operationId: "operation-1",
      transferId: "transfer-1", targetName: "设备", extra: true,
    }],
    [buildAnchorUninstallContinueMethod, {
      operationId: "operation-1", confirmBackup: true, recoveryPackage: "package", extra: true,
    }],
    [buildAnchorUninstallCancelMethod, { operationId: "operation-1", extra: true }],
    [buildAnchorUninstallStatusMethod, { operationId: "operation-1", extra: true }],
  ] as const)("rejects unknown uninstall fields before lifecycle effects", async (build, params) => {
    const uninstall = {
      beginMigration: vi.fn(async () => currentRemovalLifecycle("migration", "gate-frozen")),
      beginRecoveryBackup: vi.fn(async () =>
        currentRemovalLifecycle("recovery-backup", "checkpoint-verified")),
      continue: vi.fn(async () =>
        currentRemovalLifecycle("recovery-backup", "retirement-decided")),
      abort: vi.fn(async () => currentRemovalLifecycle("recovery-backup", "aborted")),
      read: vi.fn(async () => undefined),
    };
    const entry = build();
    const ctx = mkCtx({
      productApi: deviceAdministrationProductApi({
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
        currentRemovalMigrationTargets: { list: async () => [] },
        currentRemovalRecovery: {
          readiness: async () => ({
            state: "not-configured",
            fullBackupReady: false,
          }),
          begin: uninstall.beginRecoveryBackup,
          confirm: uninstall.continue,
          resumeActive: async () => [],
        },
        currentRemovalMigration: {
          begin: uninstall.beginMigration,
          resumeActive: async () => [],
        },
        currentDeviceRemoval: {
          abort: uninstall.abort,
          read: uninstall.read,
        },
      }),
    });
    ctx.connection.loopback = true;
    await expect(entry.handler(params, ctx))
      .rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    for (const operation of Object.values(uninstall)) expect(operation).not.toHaveBeenCalled();
  });
});

function currentRemovalLifecycle(
  path: "migration" | "recovery-backup",
  phase:
    | "gate-frozen"
    | "checkpoint-verified"
    | "retirement-decided"
    | "aborted",
) {
  return { kind: "current-device-removal" as const, path, phase };
}

describe("server.shutdown", () => {
  it("rejects authenticated non-loopback callers before decoding or lifecycle effects", async () => {
    const trigger = vi.fn();
    const prepare = vi.fn();
    const ctx = mkCtx({ requestShutdown: trigger, lifecycleShutdown: { prepare } });
    ctx.connection.loopback = false;

    await expect(buildServerShutdownMethod().handler({ malformed: true }, ctx))
      .rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    expect(prepare).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
  });

  it.each([
    [undefined],
    [null],
    [[]],
    [{}],
    [{ requestId: "shutdown-invalid", unknown: true }],
    [{ requestId: "" }],
    [{ requestId: "shutdown-invalid", reason: null }],
    [{ requestId: "shutdown-invalid", reason: "" }],
    [{ requestId: "shutdown-invalid", strategy: "later" }],
    [{ requestId: "shutdown-invalid", timeoutMs: null }],
    [{ requestId: "shutdown-invalid", timeoutMs: 0 }],
    [{ requestId: "shutdown-invalid", timeoutMs: -1 }],
    [{ requestId: "shutdown-invalid", timeoutMs: Number.NaN }],
    [{ requestId: "shutdown-invalid", timeoutMs: Number.POSITIVE_INFINITY }],
    [{ requestId: "shutdown-invalid", timeoutMs: Number.MAX_VALUE }],
  ])("rejects malformed public input before lifecycle effects: %j", async (params) => {
    const trigger = vi.fn();
    const prepare = vi.fn();
    const ctx = mkCtx({ requestShutdown: trigger, lifecycleShutdown: { prepare } });

    await expect(buildServerShutdownMethod().handler(params, ctx))
      .rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    expect(prepare).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
  });

  it("prepares the durable lifecycle before requesting process shutdown", async () => {
    const trigger = vi.fn();
    const prepare = vi.fn(async (input: ShutdownPrepareInput) => ({
      requestId: input.requestId,
      phase: "ready-to-stop" as const,
      strategy: input.strategy,
    }));
    const entry = buildServerShutdownMethod();
    const ctx = mkCtx({ requestShutdown: trigger, lifecycleShutdown: { prepare } });

    const result = await entry.handler({ requestId: "shutdown-1", reason: "test-cleanup" }, ctx);
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "shutdown-1",
      reason: "test-cleanup",
      strategy: "immediate",
    }));
    await Promise.resolve();
    expect(trigger).toHaveBeenCalledWith("test-cleanup:immediate");
    expect(result).toMatchObject({
      accepted: true,
      requestId: "shutdown-1",
      phase: "ready-to-stop",
      strategy: "immediate",
    });
    expect(typeof result.estimatedCompleteAt).toBe("string");
  });

  it("uses the default reason when params.reason is missing", async () => {
    const trigger = vi.fn();
    const ctx = mkCtx({
      requestShutdown: trigger,
      lifecycleShutdown: lifecycleReady(),
    });
    await buildServerShutdownMethod().handler({ requestId: "shutdown-default" }, ctx);
    await Promise.resolve();
    expect(trigger).toHaveBeenCalledWith("rpc.server.shutdown:immediate");
  });

  it("throws INTERNAL_ERROR when shutdown hooks are not wired", async () => {
    const ctx = mkCtx({ requestShutdown: undefined, lifecycleShutdown: undefined });
    await expect(buildServerShutdownMethod().handler({ requestId: "shutdown-unwired" }, ctx)).rejects.toEqual(
      expect.objectContaining({
        name: "RpcAppError",
        code: RPC_ERROR_CODES.INTERNAL_ERROR,
      }),
    );
  });

  it("requires auth (requiresAuth: true)", () => {
    const entry = buildServerShutdownMethod();
    expect(entry.requiresAuth).toBe(true);
  });

  it("does not await the process shutdown callback after lifecycle readiness", async () => {
    const trigger = vi.fn(() => new Promise(() => {})); // 永不 resolve
    const ctx = mkCtx({ requestShutdown: trigger, lifecycleShutdown: lifecycleReady() });
    await expect(buildServerShutdownMethod().handler({ requestId: "shutdown-no-await" }, ctx))
      .resolves.toMatchObject({ phase: "ready-to-stop" });
    await Promise.resolve();
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("accepts timeoutMs param in estimatedCompleteAt calculation", async () => {
    const trigger = vi.fn();
    const ctx = mkCtx({ requestShutdown: trigger, lifecycleShutdown: lifecycleReady() });
    const before = Date.now();
    const result = await buildServerShutdownMethod().handler({
      requestId: "shutdown-timeout",
      timeoutMs: 60_000,
    }, ctx);
    const eta = Date.parse(result.estimatedCompleteAt);
    expect(eta).toBeGreaterThanOrEqual(before + 60_000);
    expect(eta).toBeLessThanOrEqual(Date.now() + 60_000 + 100);
  });

  it("waits for lifecycle readiness before triggering shutdown", async () => {
    const trigger = vi.fn();
    let release!: () => void;
    const prepared = new Promise<void>((resolve) => { release = resolve; });
    const prepare = vi.fn(async (input: ShutdownPrepareInput) => {
      await prepared;
      return { requestId: input.requestId, phase: "ready-to-stop" as const, strategy: input.strategy };
    });
    const ctx = mkCtx({ requestShutdown: trigger, lifecycleShutdown: { prepare } });
    const result = buildServerShutdownMethod().handler({
      requestId: "shutdown-drain",
      reason: "user-stop",
      strategy: "drain",
      timeoutMs: 1_000,
    }, ctx);
    await Promise.resolve();
    expect(trigger).not.toHaveBeenCalled();
    release();
    await expect(result).resolves.toMatchObject({ strategy: "drain", phase: "ready-to-stop" });
    await Promise.resolve();
    expect(trigger).toHaveBeenCalledWith("user-stop:drain");
  });

  it("projects unsupported prepare failures as one stable retry action and never triggers", async () => {
    const trigger = vi.fn();
    const ctx = mkCtx({
      requestShutdown: trigger,
      lifecycleShutdown: { prepare: vi.fn(async () => {
        throw new Error("owner /private/home accepted work blocked");
      }) },
    });
    await expect(buildServerShutdownMethod().handler({
      requestId: "shutdown-blocked",
      reason: "user-stop",
      strategy: "drain",
      timeoutMs: 100,
    }, ctx)).rejects.toMatchObject({
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
      message: "安全停机未完成",
      data: { action: "retry-same-request" },
    });
    expect(trigger).not.toHaveBeenCalled();
  });

  it("preserves existing RpcAppError and emits the stable failure through the real dispatcher", async () => {
    const existing = new RpcAppError(RPC_ERROR_CODES.BUSY, "已有阻断", { action: "wait" });
    const existingCtx = mkCtx({
      requestShutdown: vi.fn(),
      lifecycleShutdown: { prepare: vi.fn(async () => { throw existing; }) },
    });
    await expect(buildServerShutdownMethod().handler({ requestId: "shutdown-existing" }, existingCtx))
      .rejects.toBe(existing);

    const registry = new HandlerRegistry();
    registry.register(buildServerShutdownMethod());
    const sendError = vi.fn();
    const server = mkCtx({
      requestShutdown: vi.fn(),
      lifecycleShutdown: { prepare: vi.fn(async () => {
        throw new Error("flush operation=device-7 path=C:/secret");
      }) },
    }).server;
    const dispatcher = new RpcDispatcher({ registry, server });
    await dispatcher.handleMessage({
      id: 37,
      authenticated: true,
      loopback: true,
      closed: false,
      clientInfo: { id: "shutdown-test" },
      sendSuccess: vi.fn(),
      sendError,
      notify: vi.fn(),
      close: vi.fn(),
      onClose: () => () => undefined,
    }, JSON.stringify({
      jsonrpc: "2.0",
      id: "shutdown-wire",
      method: "server.shutdown",
      params: { requestId: "shutdown-wire", strategy: "cancel" },
    }));
    expect(sendError).toHaveBeenCalledWith("shutdown-wire", {
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
      message: "安全停机未完成",
      data: { action: "retry-same-request" },
    });
    expect(JSON.stringify(sendError.mock.calls)).not.toMatch(/flush|device-7|secret/iu);
  });
});

type ShutdownPrepareInput = {
  readonly requestId: string;
  readonly reason: string;
  readonly strategy: "immediate" | "drain" | "cancel";
  readonly timeoutMs: number;
};

function lifecycleReady() {
  return {
    prepare: async (input: ShutdownPrepareInput) => ({
      requestId: input.requestId,
      phase: "ready-to-stop" as const,
      strategy: input.strategy,
    }),
  };
}

describe("dutyMigration.*", () => {
  it("只暴露用户可理解的目标和阶段，并原样绑定稳定请求身份", async () => {
    const targets = vi.fn(async () => [
      { deviceId: "device-ready", displayName: "客厅主机", ready: true },
    ]);
    const prepare = vi.fn(async () => undefined);
    const commit = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const ctx = mkCtx({
      productApi: deviceAdministrationProductApi({
        dutyMigrationTargets: { list: targets },
        dutyMigrationContext: {
          read: () => ({
            localDeviceId: "device-duty",
            currentDutyDeviceId: "device-duty",
            currentOwnerReady: true,
            deviceRemovalInProgress: false,
            members: [{
              deviceId: "device-ready",
              state: "active",
              dutyCapable: true,
            }],
          }),
        },
        dutyMigration: { prepare, commit, cancel },
      }),
    });
    const identity = {
      requestId: "request:duty-1",
      transferId: "duty-1",
    };

    await expect(buildDutyMigrationTargetsMethod().handler({}, ctx)).resolves.toEqual({
      devices: [{ deviceId: "device-ready", displayName: "客厅主机", ready: true }],
    });
    await expect(buildDutyMigrationPrepareMethod().handler(
      { ...identity, targetDeviceId: "device-ready" },
      ctx,
    )).resolves.toEqual({ stage: "ready" });
    await expect(buildDutyMigrationCommitMethod().handler(identity, ctx)).resolves.toEqual({
      stage: "completed",
    });
    await expect(buildDutyMigrationCancelMethod().handler(identity, ctx)).resolves.toEqual({
      stage: "cancelled",
    });
    expect(prepare).toHaveBeenCalledWith({ ...identity, targetDeviceId: "device-ready" });
    expect(commit).toHaveBeenCalledWith(identity);
    expect(cancel).toHaveBeenCalledWith(identity);
    for (const entry of [
      buildDutyMigrationTargetsMethod(),
      buildDutyMigrationPrepareMethod(),
      buildDutyMigrationCommitMethod(),
      buildDutyMigrationCancelMethod(),
    ]) {
      expect(entry.requiresAuth).toBe(true);
    }
  });

  it("严格拒绝未知字段和不稳定身份", async () => {
    const ctx = mkCtx({
      productApi: deviceAdministrationProductApi(),
    });
    await expect(buildDutyMigrationTargetsMethod().handler({ extra: true }, ctx))
      .rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    await expect(buildDutyMigrationPrepareMethod().handler({
      requestId: "request:duty-1",
      transferId: "duty-1",
      targetDeviceId: "device-ready",
      extra: true,
    }, ctx)).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    await expect(buildDutyMigrationCommitMethod().handler({
      requestId: "",
      transferId: "duty-1",
    }, ctx)).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
  });

  it("缺少 Device Administration contribution 时三条写入口一致 fail closed", async () => {
    const ctx = mkCtx();
    const identity = { requestId: "request:duty-1", transferId: "duty-1" };
    for (const action of [
      () => buildDutyMigrationPrepareMethod().handler({
        ...identity,
        targetDeviceId: "device-ready",
      }, ctx),
      () => buildDutyMigrationCommitMethod().handler(identity, ctx),
      () => buildDutyMigrationCancelMethod().handler(identity, ctx),
    ]) {
      await expect(action()).rejects.toMatchObject({
        code: RPC_ERROR_CODES.INTERNAL_ERROR,
        message: "值班设备迁移当前不可用",
      });
    }
  });

  it("把目标缺口、结果不明和提交后取消投影为可行动文案", async () => {
    const ctx = mkCtx({
      productApi: deviceAdministrationProductApi({
        dutyMigrationContext: {
          read: () => ({
            localDeviceId: "device-duty",
            currentDutyDeviceId: "device-duty",
            currentOwnerReady: true,
            deviceRemovalInProgress: false,
            members: [{
              deviceId: "device-ready",
              state: "active",
              dutyCapable: true,
            }],
          }),
        },
        dutyMigration: {
        prepare: vi.fn(async () => {
          throw new Error("Target credentials are not unlocked");
        }),
        commit: vi.fn(async () => {
          throw new Error("target unavailable after source commit");
        }),
        cancel: vi.fn(async () => {
          throw new Error("committed transfer rejects abort");
        }),
        },
      }),
    });
    const identity = { requestId: "request:duty-1", transferId: "duty-1" };
    const errors = await Promise.all([
      buildDutyMigrationPrepareMethod().handler(
        { ...identity, targetDeviceId: "device-ready" },
        ctx,
      ).catch((error) => error as RpcAppError),
      buildDutyMigrationCommitMethod().handler(identity, ctx)
        .catch((error) => error as RpcAppError),
      buildDutyMigrationCancelMethod().handler(identity, ctx)
        .catch((error) => error as RpcAppError),
    ]);
    expect(errors.map((error) => error.message)).toEqual([
      "目标设备的本地配置尚未解锁，请先在目标设备启动知行并完成配置",
      "迁移暂时未完成。系统会保持安全状态，请确认两台设备在线后使用同一迁移编号继续",
      "设备接管已经开始，不能取消；请继续完成本次迁移，之后可再次迁移",
    ]);
    expect(errors.map((error) => error.message).join(" ")).not.toMatch(
      /anchor|epoch|issuer|catalog|commit|abort/iu,
    );
  });
});

describe("server.info", () => {
  it("返回宿主状态权威视图(要求认证——含 workspace / 会话规模等运维信息)", async () => {
    const ctx = mkCtx({
      listenAddr: { port: 18900, host: "127.0.0.1" },
      requestShutdown: () => {},
    });
    const entry = buildServerInfoMethod();
    expect(entry.requiresAuth).toBe(true);

    const result = await entry.handler({}, ctx) as any;
    expect(result.version).toBe("0.1.0-test");
    expect(result.pid).toBe(process.pid);
    expect(result.port).toBe(18900);
    expect(result.shutdownAvailable).toBe(true);
    expect(typeof result.uptimeSec).toBe("number");
    expect(result.uptimeSec).toBeGreaterThanOrEqual(0);
    // 宿主状态权威视图——占用红线可见面与协议兼容判定
    expect(result.protocol).toBe(1);
    expect(typeof result.memoryRssBytes).toBe("number");
    expect(result.memoryRssBytes).toBeGreaterThan(0);
    expect(result.activeConversations).toBe(0);
    expect(result.connectionCount).toBe(0);
  });

  it("叠加活跃会话 / 连接数 / 宿主装配信息(workspace / logPath)", async () => {
    const ctx = mkCtx({
      conversations: {
        list: () => [{ busy: true }, { busy: false }],
      } as never,
      connectionCount: () => 3,
      hostInfo: { workspace: "/ws", logPath: "/log/host.log" },
    });
    const result = await buildServerInfoMethod().handler({}, ctx) as any;
    expect(result.activeConversations).toBe(2);
    expect(result.busyConversations).toBe(1);
    expect(result.connectionCount).toBe(3);
    expect(result.workspace).toBe("/ws");
    expect(result.logPath).toBe("/log/host.log");
  });

  it("叠加 MCP 状态快照", async () => {
    const ctx = mkCtx({
      mcpStatuses: () => [
        {
          serverId: "github",
          transport: "stdio",
          status: "connected",
          toolCount: 3,
        },
      ],
    });
    const result = await buildServerInfoMethod().handler({}, ctx) as any;
    expect(result.mcpServers).toEqual([
      {
        serverId: "github",
        transport: "stdio",
        status: "connected",
        toolCount: 3,
      },
    ]);
  });

  it("叠加通道状态快照", async () => {
    const ctx = mkCtx({
      channelStatuses: () => [
          {
            channelId: "feishu",
            state: "connecting",
          },
        ],
    });
    const result = await buildServerInfoMethod().handler({}, ctx) as any;
    expect(result.channels).toEqual([
      {
        channelId: "feishu",
        state: "connecting",
      },
    ]);
  });

  it("叠加运行控制投影", async () => {
    const ctx = {
      ...mkCtx({
        conversations: {
          list: () => [
            {
              conversationId: "conv-1",
              busy: true,
              pendingCount: 2,
            },
          ],
        } as never,
        productApi: new ProductApiDispatcher(
          SCHEDULE_RUNTIME_PRODUCT_API_EXACT_SET,
          [createScheduleRuntimeProductApiContribution({
            readStatus: () => ({
              activeRunCount: 1,
              enabledUserTaskCount: 1,
              turnContext: { active: [], recentlyCompleted: [], recentlyFailed: [] },
            }),
            onEvent: () => () => undefined,
          })],
        ),
        runtimeControl: {
          deliveryStats: () => ({
            pending: 3,
            queued: 3,
            attempting: 0,
            delivered: 0,
            failed: 0,
            retrying: 1,
            uncertain: 0,
          }),
        },
        channelStatuses: () => [
            { channelId: "feishu", state: "connected" },
            { channelId: "slack", state: "disconnected" },
          ],
        connectionCount: () => 2,
      }),
      connection: { id: 7, authenticated: true } as never,
    };

    const result = await buildServerInfoMethod().handler({}, ctx) as any;

    expect(result.accessSurfaces.otherRpcConnections).toBe(1);
    expect(result.accessSurfaces.liveChannels).toEqual([
      { channelId: "feishu", state: "connected" },
    ]);
    expect(result.activeWork.count).toBe(4);
    expect(result.activeWork.cancellableWork).toMatchObject([
      { id: "conversation:conv-1", count: 3 },
      { id: "scheduler:runs", count: 1 },
    ]);
    expect(result.deferredWork).toMatchObject([
      { id: "delivery:queue", count: 3 },
    ]);
    expect(result.keepAliveWork).toMatchObject([
      { id: "scheduler:enabled", count: 1 },
    ]);
  });

  it("marks shutdownAvailable=false when requestShutdown not wired", async () => {
    const ctx = mkCtx({ requestShutdown: undefined });
    const result = await buildServerInfoMethod().handler({}, ctx) as any;
    expect(result.shutdownAvailable).toBe(false);
  });

  it("returns delivery history after each caller's durable revision", async () => {
    const deliveryStatus = vi.fn(async () => [{
      v: 1,
      ref: { execution: "delivery", itemId: "dlv-01KXPWTM80BYB4SH423EJT1CVN" },
      state: "delivery-failed",
      statusRevision: 4,
      actions: [],
      at: "2026-07-17T02:00:00.000Z",
      attempt: 1,
      anchorEpoch: 2,
    }]);
    const ctx = mkCtx({ runtimeControl: { deliveryStatus } });

    const result = await buildServerInfoMethod().handler({
      deliveryStatusAfter: { "dlv-01KXPWTM80BYB4SH423EJT1CVN": 3 },
    }, ctx) as any;

    expect(deliveryStatus).toHaveBeenCalledWith({
      "dlv-01KXPWTM80BYB4SH423EJT1CVN": 3,
    });
    expect(result.deliveryStatus).toHaveLength(1);
  });

  it("returns scheduler notices from the caller's scalar durable cursor", async () => {
    const notice = {
      noticeId: "gap-1",
      revision: 9,
      kind: "capability-gap" as const,
      state: "open" as const,
      ref: {
        kind: "capability-gap" as const,
        taskId: "task-1",
        jobRunId: "job-1",
        round: 1,
      },
      reason: "缺少执行能力",
      actions: ["检查目标设备"],
      at: "2026-08-02T00:00:00.000Z",
    };
    const schedulerNotices = vi.fn(async () => ({
      notices: [notice],
      nextRevision: 9,
    }));
    const ctx = mkCtx({ runtimeControl: { schedulerNotices } });

    const result = await buildServerInfoMethod().handler({
      schedulerNoticeAfter: 4,
    }, ctx) as any;

    expect(schedulerNotices).toHaveBeenCalledWith(4);
    expect(result.schedulerNotices).toEqual([notice]);
    expect(result.schedulerNoticeNext).toBe(9);
  });

  it("returns conversation status history after each run cursor", async () => {
    const conversationStatus = vi.fn(async () => ({
      notices: [{
        v: 1,
        ref: {
          execution: "conversation",
          conversationId: "conversation-1",
          runId: "run-1",
          ownerEpoch: 1,
        },
        state: "uncertain",
        statusRevision: 4,
        actions: ["verify-side-effects", "abandon", "retry-risk-ack"],
        at: "2026-07-18T02:00:00.000Z",
        openFactDigest: `sha256:${"a".repeat(64)}`,
      }],
      next: [{
        conversationId: "conversation-1",
        runId: "run-1",
        afterStatusRevision: 4,
      }],
    }));
    const ctx = mkCtx({ runtimeControl: { conversationStatus } });
    const cursor = {
      conversationId: "conversation-1",
      runId: "run-1",
      afterStatusRevision: 3,
    };

    const result = await buildServerInfoMethod().handler({
      conversationStatusAfter: [cursor],
    }, ctx) as any;

    expect(conversationStatus).toHaveBeenCalledWith([cursor]);
    expect(result.conversationStatus).toHaveLength(1);
    expect(result.conversationStatusNext).toEqual([
      { conversationId: "conversation-1", runId: "run-1", afterStatusRevision: 4 },
    ]);
  });

  it("只投影用户级恢复备份状态", async () => {
    const ctx = mkCtx({
      recoveryBackupStatus: async () => ({
        state: "unavailable",
        fullBackupReady: true,
        nextAction: "restore-backup-connection",
      }),
    });
    const result = await buildServerInfoMethod().handler({}, ctx) as any;
    expect(result.recoveryBackup).toEqual({
      state: "unavailable",
      fullBackupReady: true,
      nextAction: "restore-backup-connection",
    });
    expect(JSON.stringify(result.recoveryBackup)).not.toMatch(
      /root|lsn|digest|mesh|runtime|anchor|executor/iu,
    );
  });

  it("hands first-party status history over to one live projection per connection", async () => {
    const close = vi.fn();
    const notify = vi.fn();
    let closeConnection: (() => void) | undefined;
    let publish:
      | ((notice: ExecutionStatusNotice) => void | Promise<void>)
      | undefined;
    const openFirstPartyFinality = vi.fn(async (
      input: Parameters<
        NonNullable<RuntimeControlAdapter["openFirstPartyFinality"]>
      >[0],
    ) => {
      publish = input.onStatus;
      await input.onStatus({
        v: 1,
        ref: {
          execution: "conversation",
          conversationId: "conversation-1",
          runId: "run-1",
          ownerEpoch: 1,
        },
        state: "running",
        statusRevision: 4,
        actions: [],
        at: "2026-07-28T02:00:00.000Z",
      });
      return {
        next: [{
          subject: {
            execution: "conversation" as const,
            conversationId: "conversation-1",
            runId: "run-1",
          },
          afterStatusRevision: 4,
        }],
        close,
      };
    });
    const ctx = {
      ...mkCtx({ runtimeControl: { openFirstPartyFinality } }),
      connection: {
        id: 9,
        authenticated: true,
        notify,
        onClose(handler: () => void) {
          closeConnection = handler;
          return vi.fn();
        },
      },
    } as unknown as HandlerContext;

    const result = await buildServerInfoMethod().handler({
      conversationStatusAfter: [{
        conversationId: "conversation-1",
        runId: "run-1",
        afterStatusRevision: 3,
      }],
    }, ctx) as any;

    expect(result.conversationStatus).toHaveLength(1);
    expect(result.conversationStatusNext).toEqual([{
      conversationId: "conversation-1",
      runId: "run-1",
      afterStatusRevision: 4,
    }]);
    await publish?.({
      v: 1,
      ref: {
        execution: "conversation",
        conversationId: "conversation-1",
        runId: "run-1",
        ownerEpoch: 1,
      },
      state: "failed",
      statusRevision: 5,
      actions: [],
      at: "2026-07-28T02:00:01.000Z",
    });
    expect(notify).toHaveBeenCalledWith(
      "session.status",
      expect.objectContaining({ statusRevision: 5 }),
    );
    closeConnection?.();
    expect(close).toHaveBeenCalledOnce();
  });

  it("returns job status history after each run cursor", async () => {
    const jobStatus = vi.fn(async () => ({
      notices: [{
        v: 1,
        ref: {
          execution: "job",
          taskId: "task-1",
          jobRunId: "job-run-1",
          anchorEpoch: 1,
        },
        state: "running",
        statusRevision: 3,
        actions: [],
        at: "2026-07-28T02:00:00.000Z",
      }],
      next: [{
        taskId: "task-1",
        jobRunId: "job-run-1",
        afterStatusRevision: 3,
      }],
    }));
    const ctx = mkCtx({ runtimeControl: { jobStatus } });
    const cursor = {
      taskId: "task-1",
      jobRunId: "job-run-1",
      afterStatusRevision: 2,
    };

    const result = await buildServerInfoMethod().handler({
      jobStatusAfter: [cursor],
    }, ctx) as any;

    expect(jobStatus).toHaveBeenCalledWith([cursor]);
    expect(result.jobStatus).toHaveLength(1);
    expect(result.jobStatusNext).toEqual([cursorWithRevision(cursor, 3)]);
  });

  it("rejects a delivery cursor outside the protocol identifier domain", async () => {
    const ctx = mkCtx({ runtimeControl: { deliveryStatus: vi.fn() } });
    await expect(
      buildServerInfoMethod().handler({
        deliveryStatusAfter: { ["i".repeat(481)]: 0 },
      }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
  });

  it("rejects malformed conversation status cursors", async () => {
    const ctx = mkCtx({ runtimeControl: { conversationStatus: vi.fn() } });
    await expect(
      buildServerInfoMethod().handler({
        conversationStatusAfter: [{
          conversationId: "conversation-1",
          runId: "run-1",
          afterStatusRevision: -1,
        }],
      }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
  });

  it("rejects malformed job status cursors", async () => {
    const ctx = mkCtx({ runtimeControl: { jobStatus: vi.fn() } });
    await expect(
      buildServerInfoMethod().handler({
        jobStatusAfter: [{
          taskId: "task-1",
          jobRunId: "job-run-1",
          afterStatusRevision: -1,
        }],
      }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
  });

  // silence lint on unused import
  it("RpcAppError is a class", () => {
    expect(typeof RpcAppError).toBe("function");
  });
});

function cursorWithRevision<T extends object>(
  cursor: T,
  afterStatusRevision: number,
): T & { afterStatusRevision: number } {
  return { ...cursor, afterStatusRevision };
}

describe("delivery.resolve", () => {
  function deliveryProductApi(
    execute: DeliveryUncertainResolutionApplication["execute"],
  ): ProductApiDispatcher {
    return new ProductApiDispatcher(DELIVERY_RESOLUTION_PRODUCT_API_EXACT_SET, [
      createDeliveryResolutionProductApiContribution({ execute }),
    ]);
  }

  it("forwards a validated decision with the authenticated surface identity", async () => {
    const execute = vi.fn<DeliveryUncertainResolutionApplication["execute"]>(async (command) => ({
      kind: "applied",
      canonicalRequestId: command.requestId,
      result: { v: 1, status: "ok", body: { t: "delivery-resolve", applied: true } },
      authorityRevision: 8,
    }));
    const ctx = {
      ...mkCtx({
        productApi: deliveryProductApi(execute),
        conversations: {
          durableControlPrincipal: (input: {
            surfacePrincipal: string;
            connectionId: string;
          }) => ({ ...input, deviceId: "anchor-device" }),
        } as never,
      }),
      connection: {
        id: 7,
        authenticated: true,
        clientInfo: { id: "desktop" },
      } as never,
    };
    const params = {
      requestId: "resolution-1",
      itemId: "dlv-01KXPWTM80BYB4SH423EJT1CVN",
      attempt: 1,
      anchorEpoch: 2,
      openFactDigest: `sha256:${"a".repeat(64)}`,
      decision: "abandon",
    } as const;

    await expect(buildDeliveryResolveMethod().handler(params, ctx)).resolves.toEqual({
      kind: "applied",
      canonicalRequestId: "resolution-1",
      result: { v: 1, status: "ok", body: { t: "delivery-resolve", applied: true } },
      authorityRevision: 8,
    });
    expect(execute).toHaveBeenCalledWith({
      requestId: params.requestId,
      itemId: params.itemId,
      attempt: params.attempt,
      resolutionFence: "delivery-resolution-fence:v1:2",
      openFactDigest: params.openFactDigest,
      decision: params.decision,
      principal: {
        surfacePrincipal: "rpc:desktop",
        deviceId: "anchor-device",
        connectionId: "7",
      },
    });
  });

  it("rejects incomplete or unknown decision fields", async () => {
    const entry = buildDeliveryResolveMethod();
    await expect(entry.handler({ decision: "abandon" }, mkCtx())).rejects.toMatchObject({
      code: RPC_ERROR_CODES.INVALID_PARAMS,
    });
  });

  it("rejects invalid request, item, and derived surface identifiers", async () => {
    const execute = vi.fn<DeliveryUncertainResolutionApplication["execute"]>();
    const entry = buildDeliveryResolveMethod();
    const valid = {
      requestId: "resolution-1",
      itemId: "dlv-01KXPWTM80BYB4SH423EJT1CVN",
      attempt: 1,
      anchorEpoch: 2,
      openFactDigest: `sha256:${"a".repeat(64)}`,
      decision: "abandon",
    };
    const ctx = {
      ...mkCtx({
        productApi: deliveryProductApi(execute),
        conversations: {
          durableControlPrincipal: (input: {
            surfacePrincipal: string;
            connectionId: string;
          }) => ({ ...input, deviceId: "anchor-device" }),
        } as never,
      }),
      connection: { id: 7, authenticated: true, clientInfo: { id: "desktop" } },
    } as never;

    await expect(
      entry.handler({ ...valid, requestId: "r".repeat(481) }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    await expect(
      entry.handler({ ...valid, itemId: "i".repeat(481) }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    await expect(
      entry.handler({ ...valid, itemId: "item-01KXPWTM80BYB4SH423EJT1CVN" }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    await expect(
      entry.handler({ ...valid, itemId: "dlv-01KXPWTM80BYB4SH423EJT1CVI" }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    await expect(
      entry.handler(valid, {
        ...ctx,
        connection: {
          id: "c".repeat(481),
          authenticated: true,
          clientInfo: { id: "desktop" },
        },
      } as never),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed with the existing wire error when the Host has no Delivery contribution", async () => {
    const ctx = mkCtx({
      conversations: {
        durableControlPrincipal: () => ({
          surfacePrincipal: "rpc:desktop",
          deviceId: "anchor-device",
          connectionId: "7",
        }),
      } as never,
    });
    ctx.connection = {
      id: 7,
      authenticated: true,
      clientInfo: { id: "desktop" },
    } as never;
    await expect(buildDeliveryResolveMethod().handler({
      requestId: "resolution-1",
      itemId: "dlv-01KXPWTM80BYB4SH423EJT1CVN",
      attempt: 1,
      anchorEpoch: 2,
      openFactDigest: `sha256:${"a".repeat(64)}`,
      decision: "abandon",
    }, ctx)).rejects.toMatchObject({
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
      message: "delivery resolution is not available",
    });
  });

  it("preserves the public result through the real RPC dispatcher", async () => {
    const execute = vi.fn<DeliveryUncertainResolutionApplication["execute"]>(async (command) => ({
      kind: "replayed",
      canonicalRequestId: command.requestId,
      result: { v: 1, status: "ok", body: { t: "delivery-resolve", applied: true } },
      authorityRevision: 11,
      commitLsn: 13,
    }));
    const registry = new HandlerRegistry();
    registry.register(buildDeliveryResolveMethod());
    const server = mkCtx({
      productApi: deliveryProductApi(execute),
      conversations: {
        durableControlPrincipal: (input: {
          surfacePrincipal: string;
          connectionId: string;
        }) => ({ ...input, deviceId: "anchor-device" }),
      } as never,
    }).server;
    const dispatcher = new RpcDispatcher({ registry, server });
    const sendSuccess = vi.fn();
    const sendError = vi.fn();
    await dispatcher.handleMessage({
      id: 7,
      authenticated: true,
      loopback: true,
      closed: false,
      clientInfo: { id: "desktop" },
      sendSuccess,
      sendError,
      notify: vi.fn(),
      close: vi.fn(),
      onClose: () => () => undefined,
    }, JSON.stringify({
      jsonrpc: "2.0",
      id: "delivery-wire",
      method: "delivery.resolve",
      params: {
        requestId: "resolution-wire",
        itemId: "dlv-01KXPWTM80BYB4SH423EJT1CVN",
        attempt: 1,
        anchorEpoch: 2,
        openFactDigest: `sha256:${"a".repeat(64)}`,
        decision: "retry-risk-ack",
      },
    }));
    expect(sendError).not.toHaveBeenCalled();
    expect(sendSuccess).toHaveBeenCalledWith("delivery-wire", {
      kind: "replayed",
      canonicalRequestId: "resolution-wire",
      result: { v: 1, status: "ok", body: { t: "delivery-resolve", applied: true } },
      authorityRevision: 11,
      commitLsn: 13,
    });
  });
});

describe("Device Administration read Product API binding", () => {
  it("projects device relationships and removal state through the shared dispatcher", async () => {
    const relationships = vi.fn(async () => [
      { displayName: "书房设备", reachable: true },
    ]);
    const removalState = vi.fn(async () => ({
      phase: "waiting-for-device" as const,
      conversations: ["conv-main"],
      localData: "known" as const,
      credentialActions: ["等待设备上线"],
    }));
    const ctx = mkCtx({
      productApi: deviceAdministrationProductApi({
        relationships: { list: relationships },
        removalState: { read: removalState },
      }),
    });

    await expect(buildDeviceListMethod().handler({}, ctx)).resolves.toEqual({
      devices: [{ displayName: "书房设备", reachable: true }],
    });
    await expect(buildDeviceStatusMethod().handler({ targetName: "书房设备" }, ctx))
      .resolves.toEqual({
        state: {
          phase: "waiting-for-device",
          conversations: ["conv-main"],
          localData: "known",
          credentialActions: ["等待设备上线"],
        },
      });
    expect(relationships).toHaveBeenCalledTimes(1);
    expect(removalState).toHaveBeenCalledWith("书房设备");
  });

  it("fails closed with the existing errors when the Host has no read contribution", async () => {
    await expect(buildDeviceListMethod().handler({}, mkCtx())).rejects.toMatchObject({
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
      message: "设备管理当前不可用",
    });
    await expect(buildDeviceStatusMethod().handler(
      { targetName: "书房设备" },
      mkCtx(),
    )).rejects.toMatchObject({
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
      message: "设备管理当前不可用",
    });
    await expect(buildDutyMigrationTargetsMethod().handler({}, mkCtx()))
      .rejects.toMatchObject({
        code: RPC_ERROR_CODES.INTERNAL_ERROR,
        message: "值班设备迁移当前不可用",
      });
  });
});

describe("llm.complete", () => {
  it("仅可信 loopback 面可调用,并转发 prompt / role", async () => {
    const complete = vi.fn(async (prompt: string, role?: "main" | "light") =>
      `${role ?? "default"}:${prompt}`,
    );
    const ctx = {
      ...mkCtx({ llmComplete: complete }),
      connection: { authenticated: true, loopback: true } as any,
    };
    const entry = buildLlmCompleteMethod();
    expect(entry.requiresAuth).toBe(true);

    await expect(
      entry.handler({ prompt: "整理 MCP 配置", role: "main" }, ctx),
    ).resolves.toEqual({ text: "main:整理 MCP 配置" });
    expect(complete).toHaveBeenCalledWith("整理 MCP 配置", "main");
  });

  it("拒绝非 loopback / 空 prompt / 非法 role / 未装配执行体", async () => {
    const entry = buildLlmCompleteMethod();
    await expect(
      entry.handler(
        { prompt: "x" },
        { ...mkCtx(), connection: { authenticated: true, loopback: false } as any },
      ),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });

    await expect(
      entry.handler(
        { prompt: "" },
        { ...mkCtx({ llmComplete: async () => "x" }), connection: { authenticated: true, loopback: true } as any },
      ),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });

    await expect(
      entry.handler(
        { prompt: "x", role: "fast" },
        { ...mkCtx({ llmComplete: async () => "x" }), connection: { authenticated: true, loopback: true } as any },
      ),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });

    await expect(
      entry.handler(
        { prompt: "x" },
        { ...mkCtx(), connection: { authenticated: true, loopback: true } as any },
      ),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INTERNAL_ERROR });
  });
});
