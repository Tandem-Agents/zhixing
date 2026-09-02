import path from "node:path";
import type { SecretStorePort } from "@zhixing/core/contracts";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import {
  FilePairedCheckpointStaging,
  PairedCheckpointReceiver,
  registerPairedCheckpointMeshService,
} from "@zhixing/mesh/paired-checkpoint-target";
import { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import { ProductionMeshControlPlane } from "./mesh-control-plane.js";
import { CredentialExposureAuthority } from "./credential-exposure-authority.js";
import type { MeshRuntimeBootstrap } from "./mesh-runtime-bootstrap.js";
import { deferredPairedCheckpointTarget } from "./paired-checkpoint-runtime.js";
import { commitRecoveryRootActivation } from "./recovery-root-activation.js";

type TrustedHomeBootstrap = Extract<MeshRuntimeBootstrap, { mode: "trusted-home" }>;

export class RecoveryRootEstablishmentRuntime {
  readonly services = new MeshServiceRegistry();
  readonly #control: ProductionMeshControlPlane;
  readonly #disposeReceiver: (() => void) | undefined;
  readonly #activated: Promise<void>;
  #resolveActivated!: () => void;
  #started = false;

  constructor(input: {
    readonly zhixingHome: string;
    readonly mesh: TrustedHomeBootstrap;
    readonly secretStore: SecretStorePort;
    readonly storageMaintenance: StorageMaintenanceGovernorPort;
    readonly onError?: (error: Error) => void;
  }) {
    if (input.mesh.trust.recoveryRootPublicKey || input.mesh.trust.recoveryBackupPublicKey) {
      throw new TypeError("Root-establishment runtime requires an unactivated recovery root");
    }
    const local = input.mesh.trust.members.find((member) =>
      member.device.deviceId === input.mesh.deviceKey.deviceId && member.state === "active");
    if (!local) throw new Error("Root-establishment runtime requires an active local member");
    if (local.device.deviceId !== input.mesh.trust.issuer.deviceId) {
      const target = deferredPairedCheckpointTarget({
        zhixingHome: input.zhixingHome,
        deviceId: local.device.deviceId,
        storageMaintenance: input.storageMaintenance,
      });
      this.#disposeReceiver = registerPairedCheckpointMeshService(
        this.services,
        new PairedCheckpointReceiver({
          homeId: input.mesh.trust.homeId,
          sourceDeviceId: input.mesh.trust.issuer.deviceId,
          targetDeviceId: local.device.deviceId,
          rootEstablishment: true,
          commitRootActivation: async ({ event, record }) => {
            await commitRecoveryRootActivation(input.mesh.bootstrapStore, event, record);
            this.#resolveActivated();
          },
          staging: new FilePairedCheckpointStaging({
            root: path.join(
              input.zhixingHome,
              "distributed-runtime",
              "recovery-checkpoint-incoming",
            ),
            target,
            storageMaintenance: input.storageMaintenance,
          }),
        }),
        (deviceId) => deviceId === input.mesh.trust.issuer.deviceId,
      );
    }
    this.#activated = new Promise<void>((resolve) => {
      this.#resolveActivated = resolve;
    });
    this.#control = new ProductionMeshControlPlane({
      localIdentity: input.mesh.deviceKey,
      trust: input.mesh.trust,
      configuration: input.mesh.configuration,
      endpoints: input.mesh.endpoints,
      transportPeers: input.mesh.transportPeers,
      secretStore: input.secretStore,
      endpointDirectory: input.mesh.bootstrapProjection.endpoints,
      transportPeerDirectory: input.mesh.bootstrapProjection.transportPeers,
      trustProjection: Object.freeze({
        loadTrustRecord: () => input.mesh.bootstrapStore.loadTrustRecord(),
      }),
      services: this.services,
      credentialRouteGuard: new CredentialExposureAuthority({
        deviceId: input.mesh.deviceKey.deviceId,
        log: input.mesh.bootstrapStore.authorityLog(),
        secretStore: input.secretStore,
      }),
      watchTrust: false,
      ...(input.mesh.localEndpoint ? { localEndpoint: input.mesh.localEndpoint } : {}),
      onTrustReconciled: (record) => {
        if (!!record.recoveryRootPublicKey !== !!record.recoveryBackupPublicKey) {
          throw new Error("Recovery root identity became inconsistent during establishment");
        }
        if (record.recoveryRootPublicKey) this.#resolveActivated();
      },
      ...(input.onError ? { onConnectionError: input.onError } : {}),
    });
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    await this.#control.start();
  }

  waitUntilActivated(): Promise<void> {
    return this.#activated;
  }

  async waitUntilIssuerDisconnected(signal?: AbortSignal): Promise<void> {
    const issuerId = this.#control.currentTrust().issuer.deviceId;
    while (this.#control.connections.has(issuerId)) {
      if (signal?.aborted) throw signal.reason;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  async stop(): Promise<void> {
    if (!this.#started) {
      try {
        await this.#control.stop();
      } finally {
        this.#disposeReceiver?.();
      }
      return;
    }
    this.#started = false;
    try {
      await this.#control.stop();
    } finally {
      this.#disposeReceiver?.();
    }
  }
}

export async function runRecoveryRootEstablishmentTopology(input: {
  readonly zhixingHome: string;
  readonly mesh: TrustedHomeBootstrap;
  readonly secretStore: SecretStorePort;
  readonly storageMaintenance: StorageMaintenanceGovernorPort;
  readonly signal?: AbortSignal;
  readonly onError?: (error: Error) => void;
}): Promise<void> {
  const runtime = new RecoveryRootEstablishmentRuntime(input);
  const ownedAbort = input.signal ? undefined : new AbortController();
  const signal = input.signal ?? ownedAbort!.signal;
  const onSignal = () => ownedAbort?.abort(new Error("Recovery root establishment stopped"));
  if (ownedAbort) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  try {
    await runtime.start();
    await Promise.race([
      runtime.waitUntilActivated(),
      waitForAbort(signal),
    ]);
    if (!signal.aborted) await runtime.waitUntilIssuerDisconnected(signal);
  } finally {
    if (ownedAbort) {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
    await runtime.stop();
  }
}

export const ROOT_ESTABLISHMENT_SERVICE_EXACT_SET = Object.freeze([
  "mesh.endpoint",
  "recovery.checkpoint",
] as const);

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
