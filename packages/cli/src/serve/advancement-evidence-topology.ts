import type { EvidenceClientPort } from "@zhixing/core/contracts";
import type {
  ProtocolSignatureVerifier,
  ProtocolSigner,
} from "@zhixing/core/protocol";
import type { AdvancementEvidenceTarget } from "@zhixing/owner-services";

/** Demand-owned evidence mechanism directory consumed by Advancement. */
export interface AdvancementEvidenceTargetDirectory {
  clientForExecutor(executorId: string): EvidenceClientPort | undefined;
}

/** Remote-only mechanism contribution implemented by Mesh infrastructure. */
export interface AdvancementEvidenceRemoteDirectory {
  remoteEvidenceClient(executorId: string): EvidenceClientPort | undefined;
}

export interface AdvancementEvidenceTopologyOptions {
  readonly local?: {
    readonly executorId: string;
    readonly client: EvidenceClientPort;
  };
  readonly remote?: AdvancementEvidenceRemoteDirectory;
}

/** Host-only local/Mesh selector; it owns no target or evidence decision. */
export class AdvancementEvidenceTopologyAdapter
  implements AdvancementEvidenceTargetDirectory {
  readonly #local:
    | { readonly executorId: string; readonly client: EvidenceClientPort }
    | undefined;
  readonly #remote: AdvancementEvidenceRemoteDirectory | undefined;

  constructor(options: AdvancementEvidenceTopologyOptions) {
    this.#local = options.local ? Object.freeze({ ...options.local }) : undefined;
    this.#remote = options.remote;
  }

  clientForExecutor(executorId: string): EvidenceClientPort | undefined {
    if (this.#local?.executorId === executorId) return this.#local.client;
    return this.#remote?.remoteEvidenceClient(executorId);
  }
}

/** Finite late-bound evidence input required by the Advancement application. */
export interface AdvancementEvidenceRuntimePort {
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  resolveTarget(
    conversationId: string,
    runId: string,
  ): Promise<AdvancementEvidenceTarget | undefined>;
  readonly targets: AdvancementEvidenceTargetDirectory;
}

/** Host assembly role; never exposed to the Advancement application. */
export interface AdvancementEvidenceHostBindingPort {
  bind(runtime: AdvancementEvidenceRuntimePort): void;
}

/**
 * Finite lifecycle binding for the Host ordering in which the Advancement
 * application exists before Authority, Conversation and Mesh are assembled.
 */
export class AdvancementEvidenceHostBinding
  implements AdvancementEvidenceRuntimePort, AdvancementEvidenceHostBindingPort {
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly targets: AdvancementEvidenceTargetDirectory;
  #runtime: AdvancementEvidenceRuntimePort | undefined;

  constructor() {
    this.signer = Object.freeze<ProtocolSigner>({
      sign: (schemaId, version, payload) =>
        this.#required().signer.sign(schemaId, version, payload),
    });
    this.verifier = Object.freeze<ProtocolSignatureVerifier>({
      verify: (schemaId, version, payload, signature) =>
        this.#required().verifier.verify(schemaId, version, payload, signature),
    });
    this.targets = Object.freeze({
      clientForExecutor: (executorId: string) =>
        this.#required().targets.clientForExecutor(executorId),
    });
  }

  resolveTarget(
    conversationId: string,
    runId: string,
  ): Promise<AdvancementEvidenceTarget | undefined> {
    return this.#required().resolveTarget(conversationId, runId);
  }

  bind(runtime: AdvancementEvidenceRuntimePort): void {
    if (this.#runtime) {
      throw new Error("Advancement evidence runtime is already bound");
    }
    this.#runtime = Object.freeze({
      signer: runtime.signer,
      verifier: runtime.verifier,
      resolveTarget: (conversationId: string, runId: string) =>
        runtime.resolveTarget(conversationId, runId),
      targets: runtime.targets,
    });
  }

  #required(): AdvancementEvidenceRuntimePort {
    if (!this.#runtime) {
      throw new Error("Advancement evidence runtime is unavailable");
    }
    return this.#runtime;
  }
}
