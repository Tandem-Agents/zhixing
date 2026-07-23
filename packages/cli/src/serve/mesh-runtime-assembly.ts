import path from "node:path";
import {
  FileResumableArtifactReceiver,
} from "@zhixing/core/authority";
import type {
  AuthorityCallContext,
  HomeTrustRecord,
  MeshEndpointDescriptor,
  MeshRoleBootConfig,
} from "@zhixing/core/contracts";
import { canonicalize } from "@zhixing/core/protocol";
import {
  MeshConnectionRegistry,
  MeshEndpointDirectory,
} from "@zhixing/mesh/bootstrap";
import type { TrustedMeshPeer } from "@zhixing/mesh/handshake";
import { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import type { RuntimeFactory } from "@zhixing/owner-kernel";
import type {
  ConversationAssignmentLedger,
  InProcessAssignmentSubmission,
} from "@zhixing/executor";
import type { AuthorityRuntimeStack } from "../setup-delivery.js";
import { AssignmentMeshComposition } from "./assignment-mesh-composition.js";
import { fulfillConnectionLifetimeObligation } from "./connection-lifetime-obligation.js";
import { ConversationAssignmentWorker } from "./conversation-assignment-worker.js";
import type {
  ConversationProtocolRuntime,
  RemoteConversationExecutionDirectory,
  RemoteConversationExecutionTarget,
} from "./conversation-protocol-runtime.js";
import type { DurableConversationInteractionObserver } from "./durable-conversation-interactions.js";
import {
  MeshExecutionSnapshotClient,
  registerExecutionSnapshotMeshService,
} from "./execution-snapshot-mesh.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { FileMeshPairingContinuationStore } from "./mesh-pairing-continuation.js";
import { ProductionMeshControlPlane } from "./mesh-control-plane.js";

const MAX_ASSIGNMENT_ARTIFACT_BYTES = 512 * 1024 * 1024;

export interface MeshRuntimeAssemblyOptions {
  readonly zhixingHome: string;
  readonly trust: HomeTrustRecord;
  readonly configuration: MeshRoleBootConfig;
  readonly endpoints: MeshEndpointDirectory;
  readonly transportPeers: readonly TrustedMeshPeer[];
  readonly localEndpoint?: MeshEndpointDescriptor;
  readonly bootstrapStore: FileMeshBootstrapStore;
  readonly authority: AuthorityRuntimeStack;
  readonly protocol?: ConversationProtocolRuntime;
  readonly executor?: {
    readonly ledger: ConversationAssignmentLedger;
    readonly runtimeFactory: RuntimeFactory;
    readonly interactions: DurableConversationInteractionObserver;
    readonly InProcessAssignmentSubmission: typeof InProcessAssignmentSubmission;
  };
  readonly secretStore: import("@zhixing/core/contracts").SecretStorePort;
  readonly onError?: (error: Error) => void;
}

/** Production composition for authenticated control services and their durable role owners. */
export class MeshRuntimeAssembly {
  readonly services = new MeshServiceRegistry();
  readonly connections = new MeshConnectionRegistry();
  readonly #composition: AssignmentMeshComposition;
  readonly #control: ProductionMeshControlPlane;
  readonly #worker: ConversationAssignmentWorker | undefined;
  readonly #disposers: Array<() => void> = [];
  #started = false;
  #closed = false;

  constructor(private readonly options: MeshRuntimeAssemblyOptions) {
    const roles = new Set(options.configuration.enabledRoles);
    if (roles.has("anchor") && !options.protocol) {
      throw new Error("Anchor mesh role requires the conversation owner protocol");
    }
    if (roles.has("executor") && !options.executor) {
      throw new Error("Executor mesh role requires the executor runtime substrate");
    }
    const receiver = new FileResumableArtifactReceiver(
      options.authority.artifacts,
      path.join(options.zhixingHome, "distributed-runtime", "mesh-artifact-partials"),
      { maxArtifactBytes: MAX_ASSIGNMENT_ARTIFACT_BYTES },
    );
    const executorRole = roles.has("executor")
      ? {
          port: options.executor!.ledger,
          guard: options.executor!.ledger,
          artifactAuthorizationFor: (assignmentId: string) =>
            options.executor!.ledger.assignmentArtifactAuthority(assignmentId),
        }
      : undefined;
    const anchorRole = roles.has("anchor")
      ? options.protocol!.submissionMeshRole()
      : undefined;
    let worker: ConversationAssignmentWorker | undefined;

    this.#composition = new AssignmentMeshComposition({
      services: this.services,
      connections: this.connections,
      storage: { artifacts: options.authority.artifacts, receiver },
      identity: {
        localDeviceId: options.authority.deviceId,
        signer: options.authority.signer,
        verifier: options.authority.verifier,
      },
      authorizeArtifact: (request) => this.#authorizeArtifact(request),
      ...(executorRole
        ? {
            executor: {
              ...executorRole,
              verifier: options.authority.verifier,
              authorizePeer: (deviceId) =>
                deviceId === options.trust.issuer.deviceId &&
                this.#peerHasRole(deviceId, "anchor"),
              onDispatchAccepted: (envelope) => worker?.accept(envelope),
              onCancelAccepted: (assignmentId) => {
                worker?.abort(assignmentId, new Error("Conversation assignment was cancelled"));
              },
            },
          }
        : {}),
      ...(anchorRole
        ? {
            anchor: {
              ...anchorRole,
              usage: options.authority.resourceGovernor,
              executorIdForPeer: (deviceId) => this.#executorIdForPeer(deviceId),
            },
          }
        : {}),
    });

    if (roles.has("executor")) {
      const anchorId = options.trust.issuer.deviceId;
      worker = new ConversationAssignmentWorker({
        ledger: options.executor!.ledger,
        runtimeFactory: options.executor!.runtimeFactory,
        artifacts: options.authority.artifacts,
        submissionFor: () => this.#composition.submissionPort(anchorId),
        resourceGovernor: options.authority.executorResourceGovernor,
        InProcessAssignmentSubmission:
          options.executor!.InProcessAssignmentSubmission,
        interactions: options.executor!.interactions,
        finalizeUsage: ({ assignmentId }) => this.finalizeExecutorUsage(assignmentId),
        onError: (_assignmentId, error) => options.onError?.(error),
      });
    }
    this.#worker = worker;

    if (roles.has("executor")) {
      this.#disposers.push(registerExecutionSnapshotMeshService(
        this.services,
        {
          currentCapability: options.authority.currentExecutorSnapshot,
          installPermission: options.authority.installPermissionSnapshot,
        },
        (deviceId) => this.#peerHasRole(deviceId, "anchor"),
        options.authority.verifier,
      ));
    }

    this.#control = new ProductionMeshControlPlane({
      localIdentity: options.authority.identityKey,
      trust: options.trust,
      configuration: options.configuration,
      endpoints: options.endpoints,
      transportPeers: options.transportPeers,
      secretStore: options.secretStore,
      bootstrapStore: options.bootstrapStore,
      services: this.services,
      connections: this.connections,
      ...(options.localEndpoint ? { localEndpoint: options.localEndpoint } : {}),
      onTrustReconciled: (record) => {
        options.authority.reconcileTrustedDevices(
          record.members.map((member) => member.device),
          record.members
            .filter((member) => member.state === "active")
            .map((member) => member.device.deviceId),
        );
      },
      onConnection: async (connection) => {
        await fulfillConnectionLifetimeObligation({
          connectionClosed: connection.closed,
          attempt: () => this.#finalizePairingBootstrap(connection.peer.deviceId),
          shouldRetry: () => true,
          onError: (error) => options.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          ),
        });
      },
      onConnectionError: (error) => options.onError?.(error),
    });

    if (roles.has("anchor")) {
      options.protocol!.bindRemoteExecution(this.#remoteDirectory());
    }
  }

  finalizeExecutorUsage(
    assignmentId: string,
  ): Promise<{ readonly reportDigest: string; readonly upToUsageSeq: number }> {
    if (!this.options.configuration.enabledRoles.includes("executor")) {
      throw new Error("Local executor role is not enabled");
    }
    return this.options.authority.executorResourceGovernor.flushAssignment(
      assignmentId,
      this.#composition.usageIntake(this.options.trust.issuer.deviceId),
      (report) => usageReporterContext(report.reporterId, report.digest),
    );
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error("Mesh runtime assembly is closed");
    if (this.#started) return;
    try {
      await this.#control.start();
      await this.#worker?.recover();
      this.#started = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#started = false;
    this.#worker?.stopAccepting();
    await this.#control.stop();
    await this.#worker?.close();
    this.#composition.close();
    for (const dispose of this.#disposers.splice(0).reverse()) dispose();
  }

  #remoteDirectory(): RemoteConversationExecutionDirectory {
    const targets = new Map<string, RemoteConversationExecutionTarget>();
    const targetFor = (deviceId: string): RemoteConversationExecutionTarget => {
      const executorId = executorIdForDevice(deviceId);
      const existing = targets.get(executorId);
      if (existing) return existing;
      const snapshots = new MeshExecutionSnapshotClient(
        this.connections.client(deviceId),
        this.options.authority.verifier,
      );
      const target = {
        executorId,
        executor: this.#composition.executorPort(deviceId, {
          verifier: this.options.authority.verifier,
          authorizationFor: (assignmentId) =>
            this.options.protocol!.assignmentArtifactAuthority(assignmentId),
        }),
        synchronizePermission: (snapshot) => snapshots.installPermission(snapshot),
      } satisfies RemoteConversationExecutionTarget;
      targets.set(executorId, target);
      return target;
    };
    const activeExecutors = () => this.#control.currentTrust().members
      .filter((member) =>
        member.state === "active" &&
        member.device.deviceId !== this.options.authority.deviceId &&
        member.roles.includes("executor"))
      .map((member) => member.device.deviceId)
      .sort((left, right) => left.localeCompare(right, "en-US"));
    return {
      candidates: async () => activeExecutors()
        .filter((deviceId) => this.connections.has(deviceId))
        .map((deviceId) => targetFor(deviceId)),
      forExecutor: (executorId) => {
        const deviceId = activeExecutors().find((candidate) =>
          executorIdForDevice(candidate) === executorId);
        return deviceId ? targetFor(deviceId) : undefined;
      },
    };
  }

  async #authorizeArtifact(
    request: import("./assignment-mesh-adapter.js").AssignmentArtifactAuthorization,
  ): Promise<void> {
    const { capability, activation, grant } = request;
    const localDeviceId = this.options.authority.deviceId;
    const peerDeviceId = request.connection.peer.deviceId;
    const localIsSource = grant.sourceDeviceId === localDeviceId;
    const peerIsSource = grant.sourceDeviceId === peerDeviceId;
    if (
      (request.access === "read" && (!localIsSource || grant.targetDeviceId !== peerDeviceId)) ||
      (request.access === "write" && (!peerIsSource || grant.targetDeviceId !== localDeviceId))
    ) {
      throw new TypeError("Assignment artifact direction does not bind this connection");
    }
    const peer = this.#control.currentTrust().members.find((member) =>
      member.device.deviceId === peerDeviceId && member.state === "active");
    if (!peer) throw new TypeError("Assignment artifact peer is not trusted");
    if (request.access === "write" && Date.parse(capability.expiry) <= Date.now()) {
      throw new TypeError("Assignment artifact write authorization is stale");
    }
    if (grant.direction === "owner-to-executor") {
      if (
        grant.sourceDeviceId !== this.options.trust.issuer.deviceId ||
        activation.signature.keyId !== grant.sourceDeviceId ||
        capability.signature.keyId !== grant.sourceDeviceId ||
        capability.executorId !== executorIdForDevice(grant.targetDeviceId) ||
        (localIsSource && !this.options.configuration.enabledRoles.includes("anchor")) ||
        (localIsSource && !peer.roles.includes("executor")) ||
        (peerIsSource && !peer.roles.includes("anchor")) ||
        (peerIsSource && !this.options.configuration.enabledRoles.includes("executor"))
      ) {
        throw new TypeError("Owner artifact grant does not bind the owning anchor and executor");
      }
      if (localIsSource) {
        await this.#assertOwnerArtifactAuthority(request);
      }
      return;
    }
    if (
      grant.targetDeviceId !== this.options.trust.issuer.deviceId ||
      activation.signature.keyId !== grant.targetDeviceId ||
      capability.signature.keyId !== grant.targetDeviceId ||
      capability.executorId !== executorIdForDevice(grant.sourceDeviceId) ||
      (localIsSource && !this.options.configuration.enabledRoles.includes("executor")) ||
      (localIsSource && !peer.roles.includes("anchor")) ||
      (peerIsSource && !peer.roles.includes("executor")) ||
      (peerIsSource && !this.options.configuration.enabledRoles.includes("anchor"))
    ) {
      throw new TypeError("Executor artifact grant does not bind its assigned executor and owner");
    }
    if (localIsSource) {
      await this.#assertExecutorArtifactAuthority(request);
    } else {
      await this.#assertOwnerArtifactAuthority(request);
    }
  }

  async #assertOwnerArtifactAuthority(
    request: import("./assignment-mesh-adapter.js").AssignmentArtifactAuthorization,
  ): Promise<void> {
    if (!this.options.protocol) {
      throw new TypeError("Local anchor role is not enabled for artifact authorization");
    }
    const durable = await this.options.protocol.assignmentArtifactAuthority(
      request.assignmentId,
    );
    if (
      canonicalize(durable.capability) !== canonicalize(request.capability) ||
      canonicalize(durable.activation) !== canonicalize(request.activation)
    ) {
      throw new TypeError("Artifact authorization is not active in the owner assignment");
    }
  }

  async #assertExecutorArtifactAuthority(
    request: import("./assignment-mesh-adapter.js").AssignmentArtifactAuthorization,
  ): Promise<void> {
    if (!this.options.executor) {
      throw new TypeError("Local executor role is not enabled for artifact authorization");
    }
    const durable = await this.options.executor.ledger.assignmentArtifactAuthority(
      request.assignmentId,
    );
    if (
      canonicalize(durable.capability) !== canonicalize(request.capability) ||
      canonicalize(durable.activation) !== canonicalize(request.activation)
    ) {
      throw new TypeError("Artifact authorization is not active in the executor assignment");
    }
  }

  #executorIdForPeer(deviceId: string): string | undefined {
    return this.#peerHasRole(deviceId, "executor")
      ? executorIdForDevice(deviceId)
      : undefined;
  }

  async #finalizePairingBootstrap(peerDeviceId: string): Promise<void> {
    const continuations = new FileMeshPairingContinuationStore(
      this.options.zhixingHome,
    );
    const continuation = await continuations.load();
    if (
      continuation?.side !== "issuer" ||
      continuation.phase !== "commit-ready" ||
      continuation.join.device.deviceId !== peerDeviceId
    ) {
      return;
    }
    const offerId = continuation.invitation.offer.offerId;
    await this.options.bootstrapStore.markBootstrapComplete(peerDeviceId, offerId);
    await this.options.secretStore.delete({
      kind: "rendezvous",
      bindingId: `pairing:${offerId}`,
    });
    await continuations.clear(offerId);
  }

  #peerHasRole(deviceId: string, role: "anchor" | "executor"): boolean {
    return this.#control.currentTrust().members.some((member) =>
      member.device.deviceId === deviceId &&
      member.state === "active" &&
      member.roles.includes(role));
  }
}

export function executorIdForDevice(deviceId: string): string {
  return `executor:${deviceId}`;
}

function usageReporterContext(
  executorId: string,
  reportDigest: string,
): AuthorityCallContext {
  return {
    principal: { kind: "usage-reporter", executorId },
    requestId: `usage-report:${reportDigest}`,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  };
}
