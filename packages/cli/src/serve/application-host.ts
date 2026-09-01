import type { DeviceRole, SecretStorePort } from "@zhixing/core/contracts";
import type { CredentialStoreCoordinator } from "@zhixing/providers";
import type { ServeOptions } from "./command.js";
import type { StartupCheckResult } from "../startup.js";
import {
  acquireExecutorLocalWorkspaceOwner,
  defineLocalWorkspaceAssemblyIdentity,
} from "../runtime/local-workspace-bootstrap.js";
import {
  createDeviceCapacityRuntime,
  type DeviceCapacityRuntime,
} from "./device-capacity-runtime.js";
import {
  prepareMeshRuntimeBootstrap,
  type MeshRuntimeBootstrap,
} from "./mesh-runtime-bootstrap.js";
import { runRecoveryRootEstablishmentTopology } from "./recovery-root-establishment-runtime.js";
import {
  planServeTopology,
  type AnchorServeBootstrapContext,
  type ExecutorRoleModule,
  type ExecutorServeBootstrapContext,
  type ServeBootstrapContext,
  type ServeRoleConfiguration,
  type ServeTopologyPlan,
} from "./role-topology.js";
import type { HostProcessMode } from "./self-exec.js";

type ReadyStartup = Extract<StartupCheckResult, { readonly kind: "ready" }>;
type TrustedHomeBootstrap = Extract<MeshRuntimeBootstrap, { readonly mode: "trusted-home" }>;
type LocalWorkspaceOwner = Awaited<
  ReturnType<typeof acquireExecutorLocalWorkspaceOwner>
>;

interface AnchorRoleModule<Options> {
  readonly runServeCommand: (
    options: Options,
    bootstrap: AnchorServeBootstrapContext,
    executor: ExecutorRoleModule | undefined,
    plan: ServeTopologyPlan,
  ) => Promise<void>;
}

interface ExecutorRoleRuntimeModule<Options> {
  readonly runExecutorRole: (
    options: Options,
    bootstrap: ExecutorServeBootstrapContext,
    executor?: ExecutorRoleModule,
  ) => Promise<void>;
}

export interface PersistentApplicationHostInput<Options> {
  readonly zhixingHome: string;
  readonly processMode: HostProcessMode;
  readonly options: Options;
  readonly startup: ReadyStartup;
  readonly secretStore: SecretStorePort & CredentialStoreCoordinator;
  readonly onRecoveryRootRequired: () => void;
}

export interface PersistentApplicationHostDependencies<Options> {
  readonly createDeviceCapacity: (temporaryRoot: string) => DeviceCapacityRuntime;
  readonly prepareMesh: typeof prepareMeshRuntimeBootstrap;
  readonly runRecoveryRoot: typeof runRecoveryRootEstablishmentTopology;
  readonly acquireLocalWorkspaceOwner: typeof acquireExecutorLocalWorkspaceOwner;
  readonly defineLocalWorkspaceIdentity: typeof defineLocalWorkspaceAssemblyIdentity;
  readonly importAnchorRole: () => Promise<AnchorRoleModule<Options>>;
  readonly importExecutorRole: () => Promise<ExecutorRoleRuntimeModule<Options>>;
  readonly importExecutorModule: () => Promise<ExecutorRoleModule>;
}

interface OwnedResource {
  released: boolean;
  readonly release: () => Promise<void>;
}

/**
 * Owns the outer lifecycle shared by every persistent role topology.
 * Role roots remain opaque components until later A1 work packages.
 */
export class PersistentApplicationHost<Options> {
  readonly descriptor: Readonly<{
    readonly zhixingHome: string;
    readonly processMode: HostProcessMode;
  }>;
  readonly #input: Readonly<PersistentApplicationHostInput<Options>>;
  readonly #dependencies: PersistentApplicationHostDependencies<Options>;
  #mesh: (OwnedResource & { readonly value: MeshRuntimeBootstrap }) | undefined;
  #localWorkspaceOwner:
    | (OwnedResource & { readonly value: Exclude<LocalWorkspaceOwner, undefined> })
    | undefined;
  #running = false;

  constructor(
    input: PersistentApplicationHostInput<Options>,
    dependencies: PersistentApplicationHostDependencies<Options>,
  ) {
    this.descriptor = Object.freeze({
      zhixingHome: input.zhixingHome,
      processMode: input.processMode,
    });
    this.#input = Object.freeze({ ...input });
    this.#dependencies = dependencies;
  }

  async run(): Promise<void> {
    if (this.#running) throw new Error("Persistent ApplicationHost can only run once");
    this.#running = true;

    let failed = false;
    let failure: unknown;
    try {
      await this.#runPersistentTopology();
    } catch (error) {
      failed = true;
      failure = error;
    }

    const cleanupFailures = await this.#releaseOuterResources();
    if (failed) {
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [failure, ...cleanupFailures],
          "Persistent ApplicationHost failed and outer cleanup also failed",
        );
      }
      throw failure;
    }
    if (cleanupFailures.length === 1) throw cleanupFailures[0];
    if (cleanupFailures.length > 1) {
      throw new AggregateError(
        cleanupFailures,
        "Persistent ApplicationHost outer cleanup failed",
      );
    }
  }

  async #runPersistentTopology(): Promise<void> {
    const deviceCapacity = this.#dependencies.createDeviceCapacity(
      `${this.#input.zhixingHome}/distributed-runtime/capacity`,
    );
    let mesh = await this.#prepareMesh(deviceCapacity);

    if (requiresRecoveryRootEstablishment(mesh)) {
      this.#input.onRecoveryRootRequired();
      await this.#dependencies.runRecoveryRoot({
        zhixingHome: this.#input.zhixingHome,
        mesh,
        secretStore: this.#input.secretStore,
        storageMaintenance: deviceCapacity.storage,
      });
      await this.#releaseCurrentMesh();
      mesh = await this.#prepareMesh(deviceCapacity);
      if (!hasEstablishedRecoveryRoot(mesh)) {
        throw new Error("恢复根激活后未形成可运行的耐久信任状态");
      }
    }

    const roles = Object.freeze([...mesh.roles]) as readonly DeviceRole[];
    const configuration = Object.freeze({ roles }) satisfies ServeRoleConfiguration;
    const plan = planServeTopology(configuration);
    const lease = await this.#dependencies.acquireLocalWorkspaceOwner(
      this.#input.zhixingHome,
      roles,
    );
    if (lease) this.#ownLocalWorkspaceLease(lease);
    const localWorkspaceIdentity = this.#dependencies.defineLocalWorkspaceIdentity(
      roles,
      lease,
    );
    const bootstrap = Object.freeze({
      mesh,
      deviceCapacity,
      secretStore: this.#input.secretStore,
      config: this.#input.startup.config,
      credentialGeneration: this.#input.startup.credentialGeneration,
      localWorkspaceIdentity,
    }) satisfies ServeBootstrapContext;

    await this.#runRoleComponents(plan, bootstrap);
  }

  async #runRoleComponents(
    plan: ServeTopologyPlan,
    bootstrap: ServeBootstrapContext,
  ): Promise<void> {
    if (plan.host === "disabled") return;

    if (plan.host === "anchor-host") {
      const [anchorRole, executor] = await Promise.all([
        this.#dependencies.importAnchorRole(),
        plan.loadExecutor
          ? this.#dependencies.importExecutorModule()
          : Promise.resolve(undefined),
      ]);
      await anchorRole.runServeCommand(
        this.#input.options,
        Object.freeze({
          ...bootstrap,
          providerCredentials: this.#input.startup.providerCredentials,
          mcpCredentials: this.#input.startup.mcpCredentials,
          channelCredentials: this.#input.startup.channelCredentials,
          credentialExposureCredentials:
            this.#input.startup.credentialExposureCredentials,
          credentialRotationCredentials:
            this.#input.startup.credentialRotationCredentials,
        }) satisfies AnchorServeBootstrapContext,
        executor,
        plan,
      );
      return;
    }

    const [executorRole, executor] = await Promise.all([
      this.#dependencies.importExecutorRole(),
      this.#dependencies.importExecutorModule(),
    ]);
    await executorRole.runExecutorRole(
      this.#input.options,
      Object.freeze({
        ...bootstrap,
        providerCredentials: this.#input.startup.providerCredentials,
        mcpCredentials: this.#input.startup.mcpCredentials,
        credentialExposureCredentials:
          this.#input.startup.credentialExposureCredentials,
      }) satisfies ExecutorServeBootstrapContext,
      executor,
    );
  }

  async #prepareMesh(deviceCapacity: DeviceCapacityRuntime): Promise<MeshRuntimeBootstrap> {
    const mesh = await this.#dependencies.prepareMesh({
      zhixingHome: this.#input.zhixingHome,
      secretStore: this.#input.secretStore,
      storageMaintenance: deviceCapacity.storage,
      ...(this.#input.startup.config.mesh
        ? { configuration: this.#input.startup.config.mesh }
        : {}),
    });
    this.#mesh = own(mesh, () => mesh.bootstrapStore.stopStorageMaintenance());
    return mesh;
  }

  #ownLocalWorkspaceLease(lease: Exclude<LocalWorkspaceOwner, undefined>): void {
    this.#localWorkspaceOwner = own(lease, () => lease.release());
  }

  async #releaseCurrentMesh(): Promise<void> {
    const mesh = this.#mesh;
    this.#mesh = undefined;
    if (mesh) await releaseOnce(mesh);
  }

  async #releaseOuterResources(): Promise<unknown[]> {
    const failures: unknown[] = [];
    for (const release of [
      () => this.#releaseCurrentMesh(),
      async () => {
        const owner = this.#localWorkspaceOwner;
        this.#localWorkspaceOwner = undefined;
        if (owner) await releaseOnce(owner);
      },
    ]) {
      try {
        await release();
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  }
}

export function createPersistentApplicationHost(
  input: PersistentApplicationHostInput<ServeOptions>,
): PersistentApplicationHost<ServeOptions> {
  return new PersistentApplicationHost(input, {
    createDeviceCapacity: createDeviceCapacityRuntime,
    prepareMesh: prepareMeshRuntimeBootstrap,
    runRecoveryRoot: runRecoveryRootEstablishmentTopology,
    acquireLocalWorkspaceOwner: acquireExecutorLocalWorkspaceOwner,
    defineLocalWorkspaceIdentity: defineLocalWorkspaceAssemblyIdentity,
    importAnchorRole: () => import("./command.js"),
    importExecutorRole: () => import("./executor-role-runtime.js"),
    importExecutorModule: () => import("@zhixing/executor"),
  });
}

function own<T>(
  value: T,
  release: () => Promise<void>,
): OwnedResource & { readonly value: T } {
  return { value, release, released: false };
}

async function releaseOnce(resource: OwnedResource): Promise<void> {
  if (resource.released) return;
  resource.released = true;
  await resource.release();
}

function requiresRecoveryRootEstablishment(
  mesh: MeshRuntimeBootstrap,
): mesh is TrustedHomeBootstrap {
  return mesh.mode === "trusted-home" &&
    !mesh.trust.recoveryRootPublicKey &&
    !mesh.trust.recoveryBackupPublicKey;
}

function hasEstablishedRecoveryRoot(mesh: MeshRuntimeBootstrap): boolean {
  return mesh.mode === "trusted-home" &&
    Boolean(mesh.trust.recoveryRootPublicKey) &&
    Boolean(mesh.trust.recoveryBackupPublicKey);
}
