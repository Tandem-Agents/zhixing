import type { SecretStorePort } from "@zhixing/core/contracts";
import {
  registerPairedCheckpointMeshService,
  type PairedCheckpointCommand,
  type PairedCheckpointCommandReceiver,
} from "@zhixing/mesh/paired-checkpoint-target";
import { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import { ProductionMeshControlPlane } from "./mesh-control-plane.js";
import { CredentialExposureAuthority } from "./credential-exposure-authority.js";
import type { MeshRuntimeBootstrap } from "./mesh-runtime-bootstrap.js";

type TrustedHomeBootstrap = Extract<MeshRuntimeBootstrap, { mode: "trusted-home" }>;

export class RecoveryRootEstablishmentRuntime {
  readonly services = new MeshServiceRegistry();
  readonly #control: ProductionMeshControlPlane;
  readonly #disposeReceiver: (() => void) | undefined;
  readonly #activated: Promise<void>;
  #resolveActivated!: () => void;
  #started = false;

  constructor(input: {
    readonly mesh: TrustedHomeBootstrap;
    readonly secretStore: SecretStorePort;
    readonly pairedCheckpointReceiver: PairedCheckpointCommandReceiver | null;
    readonly onError?: (error: Error) => void;
  }) {
    this.#activated = new Promise<void>((resolve) => {
      this.#resolveActivated = resolve;
    });
    if (input.mesh.trust.recoveryRootPublicKey || input.mesh.trust.recoveryBackupPublicKey) {
      throw new TypeError("Root-establishment runtime requires an unactivated recovery root");
    }
    const local = input.mesh.trust.members.find((member) =>
      member.device.deviceId === input.mesh.deviceKey.deviceId && member.state === "active");
    if (!local) throw new Error("Root-establishment runtime requires an active local member");
    const requiresPairedCheckpointReceiver =
      local.device.deviceId !== input.mesh.trust.issuer.deviceId;
    if (requiresPairedCheckpointReceiver !== (input.pairedCheckpointReceiver !== null)) {
      throw new TypeError("Root-establishment paired checkpoint receiver does not match this topology");
    }
    const pairedCheckpointReceiver = input.pairedCheckpointReceiver;
    if (pairedCheckpointReceiver) {
      this.#disposeReceiver = registerPairedCheckpointMeshService(
        this.services,
        Object.freeze({
          request: async (command: PairedCheckpointCommand, signal?: AbortSignal) => {
            const result = await pairedCheckpointReceiver.request(command, signal);
            if (result.t === "checkpoint.root-activated") this.#resolveActivated();
            return result;
          },
        }),
        (deviceId) => deviceId === input.mesh.trust.issuer.deviceId,
      );
    }
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
  readonly mesh: TrustedHomeBootstrap;
  readonly secretStore: SecretStorePort;
  readonly pairedCheckpointReceiver: PairedCheckpointCommandReceiver | null;
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
