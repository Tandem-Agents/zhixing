import type { ArtifactStore, FileResumableArtifactReceiver } from "@zhixing/core/authority";
import type {
  AuthorityCallContext,
  AuthorityCapability,
  DispatchEnvelope,
  ResourceUsageIntake,
  RunExecutorPort,
  RunSubmissionPort,
} from "@zhixing/core/contracts";
import type {
  ProtocolSignatureVerifier,
  ProtocolSigner,
} from "@zhixing/core/protocol";
import type { OwnerControlPreflightPort } from "@zhixing/executor";
import type { MeshConnectionRegistry } from "@zhixing/mesh/bootstrap";
import type { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import type {
  AssignmentSubmissionPreflightPort,
} from "@zhixing/owner-kernel";
import {
  MeshResourceUsageIntake,
  MeshRunExecutorPort,
  MeshRunSubmissionPort,
  registerAssignmentArtifactService,
  registerResourceUsageMeshService,
  registerRunExecutorMeshService,
  registerRunSubmissionMeshService,
  type AnyAssignmentActivationProof,
  type AssignmentArtifactAuthorization,
} from "./assignment-mesh-adapter.js";

export interface AssignmentMeshStorage {
  readonly artifacts: ArtifactStore;
  readonly receiver: FileResumableArtifactReceiver;
}

export interface AssignmentMeshIdentity {
  readonly localDeviceId: string;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly clock?: () => number;
}

export interface AssignmentMeshExecutorRole {
  readonly port: RunExecutorPort;
  readonly guard: OwnerControlPreflightPort;
  readonly verifier: ProtocolSignatureVerifier;
  readonly authorizePeer: (deviceId: string) => boolean;
  readonly artifactAuthorizationFor: (assignmentId: string) => Promise<{
    readonly capability: AuthorityCapability;
    readonly activation: AnyAssignmentActivationProof;
  }>;
  readonly onDispatchAccepted?: (
    envelope: DispatchEnvelope,
    activation: AnyAssignmentActivationProof,
    context: AuthorityCallContext,
  ) => void | Promise<void>;
  readonly onCancelAccepted?: (
    assignmentId: string,
    context: AuthorityCallContext,
  ) => void | Promise<void>;
}

export interface AssignmentMeshAnchorRole {
  readonly submission: RunSubmissionPort;
  readonly submissionGuard: AssignmentSubmissionPreflightPort;
  readonly usage: ResourceUsageIntake;
  readonly executorIdForPeer: (deviceId: string) => string | undefined;
}

export interface AssignmentMeshCompositionOptions {
  readonly services: MeshServiceRegistry;
  readonly connections: MeshConnectionRegistry;
  readonly storage: AssignmentMeshStorage;
  readonly identity: AssignmentMeshIdentity;
  readonly authorizeArtifact: (
    request: AssignmentArtifactAuthorization,
  ) => void | Promise<void>;
  readonly executor?: AssignmentMeshExecutorRole;
  readonly anchor?: AssignmentMeshAnchorRole;
}

/** Registers each enabled role's existing durable ports without introducing a second state machine. */
export class AssignmentMeshComposition {
  readonly #disposers: Array<() => void> = [];

  constructor(private readonly options: AssignmentMeshCompositionOptions) {
    this.#disposers.push(registerAssignmentArtifactService(options.services, {
      ...options.storage,
      verifier: options.identity.verifier,
      ...(options.identity.clock ? { clock: options.identity.clock } : {}),
      authorize: options.authorizeArtifact,
    }));
    if (options.executor) {
      this.#disposers.push(registerRunExecutorMeshService(options.services, {
        port: options.executor.port,
        guard: options.executor.guard,
        artifacts: options.storage.artifacts,
        verifier: options.executor.verifier,
        signer: options.identity.signer,
        localDeviceId: options.identity.localDeviceId,
        artifactAuthorizationFor: options.executor.artifactAuthorizationFor,
        ...(options.identity.clock ? { clock: options.identity.clock } : {}),
        authorizePeer: options.executor.authorizePeer,
        ...(options.executor.onDispatchAccepted
          ? { onDispatchAccepted: options.executor.onDispatchAccepted }
          : {}),
        ...(options.executor.onCancelAccepted
          ? { onCancelAccepted: options.executor.onCancelAccepted }
          : {}),
      }));
    }
    if (options.anchor) {
      this.#disposers.push(registerRunSubmissionMeshService(options.services, {
        port: options.anchor.submission,
        guard: options.anchor.submissionGuard,
        artifacts: options.storage.artifacts,
        executorIdForPeer: options.anchor.executorIdForPeer,
      }));
      this.#disposers.push(registerResourceUsageMeshService(options.services, {
        intake: options.anchor.usage,
        reporterIdForPeer: options.anchor.executorIdForPeer,
      }));
    }
  }

  executorPort(
    peerDeviceId: string,
    input: Omit<
      ConstructorParameters<typeof MeshRunExecutorPort>[0],
      | "client"
      | "artifacts"
      | "receiver"
      | "signer"
      | "localDeviceId"
      | "peerDeviceId"
      | "clock"
    >,
  ): RunExecutorPort {
    return new MeshRunExecutorPort({
      ...input,
      ...this.options.storage,
      signer: this.options.identity.signer,
      localDeviceId: this.options.identity.localDeviceId,
      peerDeviceId,
      ...(this.options.identity.clock ? { clock: this.options.identity.clock } : {}),
      client: this.options.connections.client(peerDeviceId),
    });
  }

  submissionPort(peerDeviceId: string): RunSubmissionPort {
    if (!this.options.executor) {
      throw new Error("Submission mesh port requires the local executor role");
    }
    return new MeshRunSubmissionPort({
      ...this.options.storage,
      signer: this.options.identity.signer,
      localDeviceId: this.options.identity.localDeviceId,
      peerDeviceId,
      authorizationFor: this.options.executor.artifactAuthorizationFor,
      ...(this.options.identity.clock ? { clock: this.options.identity.clock } : {}),
      client: this.options.connections.client(peerDeviceId),
    });
  }

  usageIntake(peerDeviceId: string): ResourceUsageIntake {
    return new MeshResourceUsageIntake({
      client: this.options.connections.client(peerDeviceId),
    });
  }

  close(): void {
    for (const dispose of this.#disposers.splice(0).reverse()) dispose();
  }
}
