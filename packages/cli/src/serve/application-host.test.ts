import type { DeviceRole } from "@zhixing/core/contracts";
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

        expect(harness.runRoleTopology).toHaveBeenCalledOnce();
        expect(harness.configuration).toEqual({ roles: topology.roles });
        expect(Object.isFrozen(harness.configuration)).toBe(true);
        expect(Object.isFrozen(harness.configuration?.roles)).toBe(true);
        expect(harness.meshStops[0]).toHaveBeenCalledOnce();
        expect(harness.releaseLease).toHaveBeenCalledTimes(
          topology.roles.includes("executor") ? 1 : 0,
        );
        expect(harness.events).toEqual([
          "capacity",
          "mesh:1",
          ...(topology.roles.includes("executor") ? ["lease"] : []),
          "role",
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
    expect(harness.runRecoveryRoot).toHaveBeenCalledOnce();
    expect(harness.prepareMesh).toHaveBeenCalledTimes(2);
    expect(harness.runRoleTopology).toHaveBeenCalledOnce();
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
      "role",
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
    expect(harness.runRoleTopology).not.toHaveBeenCalled();
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
    expect(harness.runRoleTopology).not.toHaveBeenCalled();
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

    expect(harness.runRoleTopology).toHaveBeenCalledOnce();
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

    expect(harness.runRoleTopology).toHaveBeenCalledOnce();
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
      config: {},
      credentials: {},
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
}) {
  const events: string[] = [];
  const meshStops: ReturnType<typeof vi.fn>[] = [];
  const deviceCapacity = {
    storage: { marker: "storage-maintenance" },
  } as unknown as DeviceCapacityRuntime;
  const releaseLease = vi.fn(async () => {
    events.push("release-lease");
  });
  const meshes = input.recoveryRequired
    ? [createMesh(false), createMesh(true)]
    : [createMesh(true)];
  let meshIndex = 0;
  let configuration: { readonly roles: readonly DeviceRole[] } | undefined;

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
  const runRoleTopology = vi.fn(async (nextConfiguration) => {
    configuration = nextConfiguration;
    events.push("role");
    if (input.roleFailure) throw input.roleFailure;
  });

  const dependencies: PersistentApplicationHostDependencies<Record<string, never>> = {
    createDeviceCapacity: () => {
      events.push("capacity");
      return deviceCapacity;
    },
    prepareMesh: prepareMesh as never,
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
    roleLoaders: {} as never,
    runRoleTopology: runRoleTopology as never,
  };

  return {
    dependencies,
    events,
    meshStops,
    prepareMesh,
    releaseLease,
    runRecoveryRoot,
    runRoleTopology,
    get configuration() {
      return configuration;
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
      trust: {
        ...(established
          ? {
              recoveryRootPublicKey: "root-key",
              recoveryBackupPublicKey: "backup-key",
            }
          : {}),
      },
      bootstrapStore: { stopStorageMaintenance: stop },
    } as unknown as MeshRuntimeBootstrap;
  }
}
