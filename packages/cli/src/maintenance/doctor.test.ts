import { describe, expect, it, vi } from "vitest";
import { inspectLocalHealth } from "./doctor.js";

describe("inspectLocalHealth", () => {
  const createDeps = () => ({
    homeDir: "C:/zhixing-doctor-test",
    backupTargets: {
      load: vi.fn(async () => undefined),
      select: vi.fn(async () => undefined),
    },
  });

  const lock = {
    pidFileVersion: 2,
    pid: 42,
    port: 18900,
    host: "127.0.0.1",
    startTime: null,
    startedAt: "2026-08-16T00:00:00.000Z",
  } as const;

  const state = (connections: readonly unknown[]) => ({
    phase: "running" as const,
    pid: lock.pid,
    port: lock.port,
    host: lock.host,
    startedAt: lock.startedAt,
    lastHeartbeat: lock.startedAt,
    extensions: {
      meshCompatibility: {
        version: 1,
        hostGeneration: {
          pid: lock.pid,
          port: lock.port,
          host: lock.host,
          startTime: lock.startTime,
          startedAt: lock.startedAt,
        },
        connections,
      },
    },
  });

  const connection = (input: {
    readonly id: string;
    readonly name: string;
    readonly local: readonly [string, string];
    readonly peer: readonly [string, string];
  }) => ({
    connectionId: `connection:${input.id}`,
    peerDeviceId: `device:${input.id}`,
    peerDisplayName: input.name,
    localRange: { min: input.local[0], max: input.local[1] },
    peerRange: { min: input.peer[0], max: input.peer[1] },
    compatibility: { mode: "read-only", reason: "incompatible-version" },
  });

  const runningStatus = (snapshot: ReturnType<typeof state>) => ({
    readLockFn: async () => lock,
    isProcessAliveFn: () => true,
    readStateFn: async () => snapshot,
  });

  it("does not create config or credentials when setup has not started", async () => {
    const deps = createDeps();
    const inspectConfig = vi.fn();
    const inspectManaged = vi.fn();
    await expect(inspectLocalHealth({
      ...deps,
      configExists: async () => false,
      inspectConfig,
      inspectManaged,
    })).resolves.toEqual({
      code: "setup-required",
      message: "知行尚未完成首次设置",
      action: "运行 zz 完成设置",
    });
    expect(inspectConfig).not.toHaveBeenCalled();
    expect(deps.backupTargets.load).not.toHaveBeenCalled();
    expect(inspectManaged).not.toHaveBeenCalled();
  });

  it("projects one managed-service recovery action from existing local facts", async () => {
    await expect(inspectLocalHealth({
      ...createDeps(),
      configExists: async () => true,
      inspectConfig: vi.fn(),
      inspectManaged: vi.fn(async () => ({ state: "needs-attention", action: "运行 zz 恢复托管" })),
    })).resolves.toEqual({
      code: "local-runtime-needs-attention",
      message: "本机运行状态需要处理",
      action: "运行 zz 恢复托管",
    });
  });

  it("does not leak raw local-state failures", async () => {
    const report = await inspectLocalHealth({
      ...createDeps(),
      configExists: async () => true,
      inspectConfig: () => { throw new Error("C:\\secret\\config.jsonc"); },
    });
    expect(report.code).toBe("local-state-unreadable");
    expect(JSON.stringify(report)).not.toContain("secret");
  });

  it("gives the local npm action first when this device is older", async () => {
    const report = await inspectLocalHealth({
      ...createDeps(),
      configExists: async () => true,
      inspectConfig: vi.fn(),
      inspectManaged: vi.fn(async () => ({ state: "ready" })),
      statusDeps: runningStatus(state([
        connection({ id: "peer", name: "书房电脑", local: ["1", "1"], peer: ["2", "2"] }),
      ])),
    });
    expect(report).toEqual({
      code: "device-maintenance-required",
      message: "这台设备需要更新后才能恢复完整协作",
      action: "请在这台设备完成以下步骤：先运行 zz stop --maintenance；成功后运行 npm install -g @zhixing/cli@latest；再运行 zz，然后重试原操作",
    });
    expect(JSON.stringify(report)).not.toMatch(/connection:|device:|协议/u);
  });

  it("lists every older peer by public name in stable order", async () => {
    const report = await inspectLocalHealth({
      ...createDeps(),
      configExists: async () => true,
      inspectConfig: vi.fn(),
      inspectManaged: vi.fn(async () => ({ state: "ready" })),
      statusDeps: runningStatus(state([
        connection({ id: "a", name: "客厅电脑", local: ["2", "2"], peer: ["1", "1"] }),
        connection({ id: "b", name: "书房电脑", local: ["2", "2"], peer: ["1", "1"] }),
        connection({ id: "c", name: "书房电脑", local: ["2", "2"], peer: ["1", "1"] }),
      ])),
    });
    expect(report).toEqual({
      code: "device-maintenance-required",
      message: "部分设备需要更新后才能恢复完整协作",
      action: "请分别在 书房电脑、书房电脑、客厅电脑 完成以下步骤：先运行 zz stop --maintenance；成功后运行 npm install -g @zhixing/cli@latest；再运行 zz，然后重试原操作",
    });
  });

  it("gives one older peer the same complete action", async () => {
    const report = await inspectLocalHealth({
      ...createDeps(),
      configExists: async () => true,
      inspectConfig: vi.fn(),
      inspectManaged: vi.fn(async () => ({ state: "ready" })),
      statusDeps: runningStatus(state([
        connection({ id: "a", name: "书房电脑", local: ["2", "2"], peer: ["1", "1"] }),
      ])),
    });
    expect(report).toEqual({
      code: "device-maintenance-required",
      message: "部分设备需要更新后才能恢复完整协作",
      action: "请分别在 书房电脑 完成以下步骤：先运行 zz stop --maintenance；成功后运行 npm install -g @zhixing/cli@latest；再运行 zz，然后重试原操作",
    });
  });

  it("fails closed on stale, corrupt or wrong-generation connection projections", async () => {
    const corrupt = state([]);
    corrupt.extensions.meshCompatibility.hostGeneration.pid += 1;
    await expect(inspectLocalHealth({
      ...createDeps(),
      configExists: async () => true,
      inspectConfig: vi.fn(),
      inspectManaged: vi.fn(async () => ({ state: "ready" })),
      statusDeps: runningStatus(corrupt),
    })).resolves.toEqual({
      code: "connection-state-unreadable",
      message: "设备连接状态无法安全确认",
      action: "重启知行后再次运行 zz doctor",
    });

    const contradictory = state([{
      connectionId: "connection:corrupt",
      peerDeviceId: "device:corrupt",
      peerDisplayName: "未知设备",
      localRange: { min: "1", max: "1" },
      peerRange: { min: "2", max: "2" },
      compatibility: { mode: "read-write", protocolVersion: "2" },
    }]);
    await expect(inspectLocalHealth({
      ...createDeps(),
      configExists: async () => true,
      inspectConfig: vi.fn(),
      inspectManaged: vi.fn(async () => ({ state: "ready" })),
      statusDeps: runningStatus(contradictory),
    })).resolves.toMatchObject({ code: "connection-state-unreadable" });
  });

  it("keeps a current no-connection projection quiet", async () => {
    await expect(inspectLocalHealth({
      ...createDeps(),
      configExists: async () => true,
      inspectConfig: vi.fn(),
      inspectManaged: vi.fn(async () => ({ state: "ready" })),
      statusDeps: runningStatus(state([])),
    })).resolves.toEqual({ code: "healthy", message: "知行本机状态正常" });
  });
});
