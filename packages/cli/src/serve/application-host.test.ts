import type { DeviceRole } from "@zhixing/core/contracts";
import type { PairedCheckpointCommandReceiver } from "@zhixing/mesh/paired-checkpoint-target";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PersistentApplicationHost,
  type PersistentApplicationHostDependencies,
  type PersistentApplicationHostInput,
} from "./application-host.js";
import type { DeviceCapacityRuntime } from "./device-capacity-runtime.js";
import type { MeshRuntimeBootstrap } from "./mesh-runtime-bootstrap.js";
import type { HostProcessMode } from "./self-exec.js";

const TOPOLOGIES = [
  { name: "anchor + local executor", roles: ["anchor", "executor"] },
  { name: "anchor-only", roles: ["anchor"] },
  { name: "executor-only", roles: ["executor"] },
] as const satisfies readonly {
  readonly name: string;
  readonly roles: readonly DeviceRole[];
}[];

const PROCESS_MODES = ["foreground", "on-demand", "managed"] as const satisfies
  readonly HostProcessMode[];

describe("persistent ApplicationHost outer lifecycle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  for (const processMode of PROCESS_MODES) {
    for (const topology of TOPOLOGIES) {
      it(`uses the same Host for ${processMode} ${topology.name}`, async () => {
        const harness = createHarness({ roles: topology.roles });
        const host = new PersistentApplicationHost(
          createInput(processMode),
          harness.dependencies,
        );

        expect(host).toBeInstanceOf(PersistentApplicationHost);
        expect(host.descriptor).toEqual({ zhixingHome: "test-home", processMode });
        expect(Object.isFrozen(host.descriptor)).toBe(true);

        await host.run();

        expect(harness.roleInvocations()).toBe(1);
        if (topology.roles.includes("anchor")) {
          expect(harness.rolePlan).toMatchObject({
            host: "anchor-host",
            loadExecutor: topology.roles.includes("executor"),
          });
        } else {
          expect(harness.rolePlan).toBeUndefined();
        }
        expect(harness.roleBootstrap?.mesh.roles).toEqual(topology.roles);
        expect(harness.createToolImplementation).toHaveBeenCalledOnce();
        expect(harness.createPlannedAnchorTransferStaging).toHaveBeenCalledOnce();
        expect(harness.closePlannedAnchorTransferStaging).toHaveBeenCalledOnce();
        expect(harness.prepareMesh.mock.calls[0]?.[0].plannedAnchorTransferStaging)
          .toBe(harness.plannedAnchorTransferStaging);
        expect(harness.roleBootstrap?.mesh.plannedAnchorTransferStaging)
          .toBe(harness.plannedAnchorTransferStaging);
        expect(harness.roleBootstrap?.toolImplementation)
          .toBe(harness.toolImplementation);
        expect(harness.roleBootstrap).not.toHaveProperty("startup");
        expect(harness.roleBootstrap).not.toHaveProperty("config");
        expect(harness.roleBootstrap).not.toHaveProperty("runtimeConfiguration");
        expect(harness.roleBootstrap).toHaveProperty("modelConfiguration");
        expect(harness.roleBootstrap).toHaveProperty(
          "kernelEnvironmentConfiguration",
        );
        expect(harness.roleBootstrap).toHaveProperty(
          "advancementConfiguration",
        );
        expect(harness.roleBootstrap).toHaveProperty("mcpConfiguration");
        expect(harness.roleBootstrap).toHaveProperty("authorityConfiguration");
        expect(harness.roleBootstrap).toHaveProperty("providerCredentials");
        expect(harness.roleBootstrap).toHaveProperty("mcpCredentials");
        expect(harness.roleBootstrap).toHaveProperty(
          "credentialExposureCredentials",
        );
        if (topology.roles.includes("anchor")) {
          expect(harness.roleBootstrap).toHaveProperty("channelConfiguration");
          expect(harness.roleBootstrap).toHaveProperty("workspaceConfiguration");
          expect(harness.roleBootstrap).toHaveProperty(
            "credentialRotationConfiguration",
          );
          expect(harness.roleBootstrap).toHaveProperty("channelCredentials");
          expect(harness.roleBootstrap).toHaveProperty(
            "credentialRotationCredentials",
          );
        } else {
          expect(harness.roleBootstrap).not.toHaveProperty(
            "channelConfiguration",
          );
          expect(harness.roleBootstrap).not.toHaveProperty(
            "workspaceConfiguration",
          );
          expect(harness.roleBootstrap).not.toHaveProperty(
            "credentialRotationConfiguration",
          );
          expect(harness.roleBootstrap).not.toHaveProperty("channelCredentials");
          expect(harness.roleBootstrap).not.toHaveProperty(
            "credentialRotationCredentials",
          );
        }
        expect(harness.importAnchorRole).toHaveBeenCalledTimes(
          topology.roles.includes("anchor") ? 1 : 0,
        );
        expect(harness.importExecutorRole).toHaveBeenCalledTimes(
          topology.roles.includes("anchor") ? 0 : 1,
        );
        expect(harness.importExecutorModule).toHaveBeenCalledTimes(
          topology.roles.includes("executor") ? 1 : 0,
        );
        expect(harness.meshStops[0]).toHaveBeenCalledOnce();
        expect(harness.releaseLease).toHaveBeenCalledTimes(
          topology.roles.includes("executor") ? 1 : 0,
        );
        expect(harness.events).toEqual([
          "capacity",
          "mesh:1",
          ...(topology.roles.includes("executor") ? ["lease"] : []),
          ...(topology.roles.includes("anchor")
            ? ["load:anchor"]
            : ["load:executor-role"]),
          ...(topology.roles.includes("executor")
            ? ["load:executor-module"]
            : []),
          topology.roles.includes("anchor") ? "role:anchor" : "role:executor",
          "stop:1",
          ...(topology.roles.includes("executor") ? ["release-lease"] : []),
        ]);
      });
    }
  }

  it("fully stops recovery bootstrap before preparing and delegating the resident topology", async () => {
    const harness = createHarness({
      roles: ["anchor", "executor"],
      recoveryRequired: true,
    });
    const recoveryNotice = vi.fn();
    const host = new PersistentApplicationHost(
      { ...createInput("foreground"), onRecoveryRootRequired: recoveryNotice },
      harness.dependencies,
    );

    await host.run();

    expect(recoveryNotice).toHaveBeenCalledOnce();
    expect(harness.createRecoveryRootPairedCheckpointReceiver).toHaveBeenCalledOnce();
    expect(harness.runRecoveryRoot).toHaveBeenCalledOnce();
    expect(harness.runRecoveryRoot.mock.calls[0]?.[0].pairedCheckpointReceiver)
      .toBe(harness.pairedCheckpointReceiver);
    expect(harness.prepareMesh).toHaveBeenCalledTimes(2);
    expect(harness.prepareMesh.mock.calls[0]?.[0].plannedAnchorTransferStaging)
      .toBe(harness.plannedAnchorTransferStaging);
    expect(harness.prepareMesh.mock.calls[1]?.[0].plannedAnchorTransferStaging)
      .toBe(harness.plannedAnchorTransferStaging);
    expect(harness.createPlannedAnchorTransferStaging).toHaveBeenCalledOnce();
    expect(harness.closePlannedAnchorTransferStaging).toHaveBeenCalledOnce();
    expect(harness.roleInvocations()).toBe(1);
    expect(harness.meshStops).toHaveLength(2);
    expect(harness.meshStops[0]).toHaveBeenCalledOnce();
    expect(harness.meshStops[1]).toHaveBeenCalledOnce();
    expect(harness.releaseLease).toHaveBeenCalledOnce();
    expect(harness.events).toEqual([
      "capacity",
      "mesh:1",
      "recovery",
      "stop:1",
      "mesh:2",
      "lease",
      "load:anchor",
      "load:executor-module",
      "role:anchor",
      "stop:2",
      "release-lease",
    ]);
  });

  it("uses the common termination path when recovery-root establishment fails", async () => {
    const failure = new Error("recovery failed");
    const harness = createHarness({
      roles: ["anchor", "executor"],
      recoveryRequired: true,
      recoveryFailure: failure,
    });

    await expect(new PersistentApplicationHost(
      createInput("managed"),
      harness.dependencies,
    ).run()).rejects.toBe(failure);

    expect(harness.prepareMesh).toHaveBeenCalledOnce();
    expect(harness.roleInvocations()).toBe(0);
    expect(harness.meshStops[0]).toHaveBeenCalledOnce();
    expect(harness.releaseLease).not.toHaveBeenCalled();
  });

  it("uses the common termination path when the resident bootstrap fails", async () => {
    const failure = new Error("second bootstrap failed");
    const harness = createHarness({
      roles: ["anchor", "executor"],
      recoveryRequired: true,
      secondBootstrapFailure: failure,
    });

    await expect(new PersistentApplicationHost(
      createInput("on-demand"),
      harness.dependencies,
    ).run()).rejects.toBe(failure);

    expect(harness.prepareMesh).toHaveBeenCalledTimes(2);
    expect(harness.roleInvocations()).toBe(0);
    expect(harness.meshStops[0]).toHaveBeenCalledOnce();
    expect(harness.meshStops[1]).not.toHaveBeenCalled();
    expect(harness.releaseLease).not.toHaveBeenCalled();
  });

  it("releases the resident mesh and workspace lease exactly once when the role root fails", async () => {
    const failure = new Error("role failed");
    const harness = createHarness({
      roles: ["executor"],
      roleFailure: failure,
    });

    await expect(new PersistentApplicationHost(
      createInput("foreground"),
      harness.dependencies,
    ).run()).rejects.toBe(failure);

    expect(harness.roleInvocations()).toBe(1);
    expect(harness.meshStops[0]).toHaveBeenCalledOnce();
    expect(harness.releaseLease).toHaveBeenCalledOnce();
  });

  it("attempts every acquired outer release when one cleanup fails", async () => {
    const roleFailure = new Error("role failed");
    const meshStopFailure = new Error("mesh stop failed");
    const harness = createHarness({
      roles: ["anchor", "executor"],
      roleFailure,
      meshStopFailure,
    });

    const result = new PersistentApplicationHost(
      createInput("managed"),
      harness.dependencies,
    ).run();

    await expect(result).rejects.toMatchObject({
      errors: [roleFailure, meshStopFailure],
    });
    expect(harness.meshStops[0]).toHaveBeenCalledOnce();
    expect(harness.releaseLease).toHaveBeenCalledOnce();
  });

  it("does not delegate or release a second time when run is called twice", async () => {
    const harness = createHarness({ roles: ["anchor"] });
    const host = new PersistentApplicationHost(
      createInput("foreground"),
      harness.dependencies,
    );

    await host.run();
    await expect(host.run()).rejects.toThrow("can only run once");

    expect(harness.roleInvocations()).toBe(1);
    expect(harness.meshStops[0]).toHaveBeenCalledOnce();
  });

  it.each([
    { roles: ["anchor"] as const, failure: "anchor" as const },
    { roles: ["anchor", "executor"] as const, failure: "executor-module" as const },
    { roles: ["executor"] as const, failure: "executor-role" as const },
  ])(
    "starts no role and releases outer resources when $failure loading fails",
    async ({ roles, failure }) => {
      const loadFailure = new Error(`${failure} failed`);
      const harness = createHarness({
        roles,
        moduleFailure: failure,
        moduleFailureError: loadFailure,
      });

      await expect(new PersistentApplicationHost(
        createInput("foreground"),
        harness.dependencies,
      ).run()).rejects.toBe(loadFailure);

      expect(harness.roleInvocations()).toBe(0);
      expect(harness.meshStops[0]).toHaveBeenCalledOnce();
      expect(harness.releaseLease).toHaveBeenCalledTimes(
        roles.includes("executor") ? 1 : 0,
      );
    },
  );

  it.each([
    { roles: [] as const },
    { roles: ["surface"] as const },
  ])("loads no role component for disabled roles $roles", async ({ roles }) => {
    const harness = createHarness({ roles });

    await new PersistentApplicationHost(
      createInput("foreground"),
      harness.dependencies,
    ).run();

    expect(harness.importAnchorRole).not.toHaveBeenCalled();
    expect(harness.importExecutorRole).not.toHaveBeenCalled();
    expect(harness.importExecutorModule).not.toHaveBeenCalled();
    expect(harness.roleInvocations()).toBe(0);
    expect(harness.meshStops[0]).toHaveBeenCalledOnce();
  });

  it.each([
    { roles: ["anchor", "anchor"] as const },
    { roles: ["unknown"] as never },
  ])("rejects invalid roles $roles before loading a role component", async ({ roles }) => {
    const harness = createHarness({ roles });

    await expect(new PersistentApplicationHost(
      createInput("foreground"),
      harness.dependencies,
    ).run()).rejects.toThrow("当前拓扑无法启动角色组合");

    expect(harness.importAnchorRole).not.toHaveBeenCalled();
    expect(harness.importExecutorRole).not.toHaveBeenCalled();
    expect(harness.importExecutorModule).not.toHaveBeenCalled();
    expect(harness.roleInvocations()).toBe(0);
    expect(harness.meshStops[0]).toHaveBeenCalledOnce();
  });
});

function createInput(
  processMode: HostProcessMode,
): PersistentApplicationHostInput<Record<string, never>> {
  return {
    zhixingHome: "test-home",
    processMode,
    options: {},
    startup: {
      kind: "ready",
      runtimeConfiguration: Object.freeze({}),
      providerCredentials: {},
      mcpCredentials: {},
      channelCredentials: {},
      credentialExposureCredentials: {},
      credentialRotationCredentials: {},
      credentialGeneration: null,
      secretStore: { marker: "secret-store" },
    } as never,
    secretStore: { marker: "secret-store" } as never,
    onRecoveryRootRequired: () => undefined,
  };
}

function createHarness(input: {
  readonly roles: readonly DeviceRole[];
  readonly recoveryRequired?: boolean;
  readonly recoveryFailure?: Error;
  readonly secondBootstrapFailure?: Error;
  readonly roleFailure?: Error;
  readonly meshStopFailure?: Error;
  readonly moduleFailure?: "anchor" | "executor-role" | "executor-module";
  readonly moduleFailureError?: Error;
}) {
  const events: string[] = [];
  const meshStops: ReturnType<typeof vi.fn>[] = [];
  const deviceCapacity = {
    storage: { marker: "storage-maintenance" },
  } as unknown as DeviceCapacityRuntime;
  const releaseLease = vi.fn(async () => {
    events.push("release-lease");
  });
  const closePlannedAnchorTransferStaging = vi.fn(async () => undefined);
  const plannedAnchorTransferStaging = {
    openTarget: vi.fn(),
    openTransfer: vi.fn(),
    cleanupPostInstall: vi.fn(),
    close: closePlannedAnchorTransferStaging,
  } as never;
  const createPlannedAnchorTransferStaging = vi.fn(() =>
    plannedAnchorTransferStaging);
  const meshes = input.recoveryRequired
    ? [createMesh(false), createMesh(true)]
    : [createMesh(true)];
  let meshIndex = 0;
  let rolePlan: unknown;
  let roleBootstrap:
    | ({ readonly mesh: MeshRuntimeBootstrap } & Record<string, unknown>)
    | undefined;

  const prepareMesh = vi.fn(async () => {
    const index = meshIndex++;
    events.push(`mesh:${index + 1}`);
    if (index === 1 && input.secondBootstrapFailure) {
      throw input.secondBootstrapFailure;
    }
    return meshes[index]!;
  });
  const runRecoveryRoot = vi.fn(async () => {
    events.push("recovery");
    if (input.recoveryFailure) throw input.recoveryFailure;
  });
  const runAnchorRole = vi.fn(async (_options, bootstrap, _executor, plan) => {
    roleBootstrap = bootstrap;
    rolePlan = plan;
    events.push("role:anchor");
    if (input.roleFailure) throw input.roleFailure;
  });
  const runExecutorRole = vi.fn(async (_options, bootstrap) => {
    roleBootstrap = bootstrap;
    events.push("role:executor");
    if (input.roleFailure) throw input.roleFailure;
  });
  const importAnchorRole = vi.fn(async () => {
    events.push("load:anchor");
    if (input.moduleFailure === "anchor") throw input.moduleFailureError;
    return { runServeCommand: runAnchorRole };
  });
  const importExecutorRole = vi.fn(async () => {
    events.push("load:executor-role");
    if (input.moduleFailure === "executor-role") throw input.moduleFailureError;
    return { runExecutorRole };
  });
  const importExecutorModule = vi.fn(async () => {
    events.push("load:executor-module");
    if (input.moduleFailure === "executor-module") throw input.moduleFailureError;
    return {} as never;
  });
  const toolImplementation = Object.freeze({ create: vi.fn() }) as never;
  const createToolImplementation = vi.fn(() => toolImplementation);
  const pairedCheckpointReceiver: PairedCheckpointCommandReceiver = Object.freeze({
    request: vi.fn(async () => {
      throw new Error("unexpected paired checkpoint request");
    }),
  });
  const createRecoveryRootPairedCheckpointReceiver = vi.fn(() =>
    pairedCheckpointReceiver);

  const dependencies: PersistentApplicationHostDependencies<Record<string, never>> = {
    createToolImplementation,
    createDeviceCapacity: () => {
      events.push("capacity");
      return deviceCapacity;
    },
    prepareMesh: prepareMesh as never,
    createPlannedAnchorTransferStaging,
    createRecoveryRootPairedCheckpointReceiver,
    runRecoveryRoot: runRecoveryRoot as never,
    acquireLocalWorkspaceOwner: (async (_home, roles) => {
      if (!roles.includes("executor")) return undefined;
      events.push("lease");
      return {
        zhixingHome: "test-home",
        endpoint: "test-endpoint",
        secretPath: "test-secret-path",
        release: releaseLease,
      };
    }) as never,
    defineLocalWorkspaceIdentity: ((roles, lease) => roles.includes("executor")
      ? { kind: "executor", lease }
      : { kind: "non-executor" }) as never,
    importAnchorRole,
    importExecutorRole,
    importExecutorModule,
  };

  return {
    dependencies,
    events,
    meshStops,
    prepareMesh,
    createRecoveryRootPairedCheckpointReceiver,
    pairedCheckpointReceiver,
    releaseLease,
    runRecoveryRoot,
    importAnchorRole,
    importExecutorRole,
    importExecutorModule,
    createToolImplementation,
    createPlannedAnchorTransferStaging,
    closePlannedAnchorTransferStaging,
    plannedAnchorTransferStaging,
    toolImplementation,
    roleInvocations: () => runAnchorRole.mock.calls.length + runExecutorRole.mock.calls.length,
    get rolePlan() {
      return rolePlan;
    },
    get roleBootstrap() {
      return roleBootstrap;
    },
  };

  function createMesh(established: boolean): MeshRuntimeBootstrap {
    const ordinal = meshStops.length + 1;
    const stop = vi.fn(async () => {
      events.push(`stop:${ordinal}`);
      if (input.meshStopFailure) throw input.meshStopFailure;
    });
    meshStops.push(stop);
    return {
      mode: "trusted-home",
      roles: input.roles,
      deviceKey: { deviceId: "target" },
      trust: {
        ...(established
          ? {
              recoveryRootPublicKey: "root-key",
              recoveryBackupPublicKey: "backup-key",
            }
          : {}),
      },
      bootstrapStore: { stopStorageMaintenance: stop },
      plannedAnchorTransferStaging,
    } as unknown as MeshRuntimeBootstrap;
  }
}
