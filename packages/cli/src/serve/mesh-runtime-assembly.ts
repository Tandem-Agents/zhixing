import path from "node:path";
import {
  assertLocalConversationIdForDevice,
  parseLocalConversationId,
} from "@zhixing/core";
import {
  FileResumableArtifactReceiver,
} from "@zhixing/core/authority";
import type {
  AuthorityCallContext,
  DeviceRole,
  HomeTrustRecord,
  MeshEndpointDescriptor,
  MeshRoleBootConfig,
  RunExecutorPort,
  RunSubmissionPort,
  EvidenceHandlerPort,
} from "@zhixing/core/contracts";
import { canonicalize } from "@zhixing/core/protocol";
import {
  MeshConnectionRegistry,
  MeshEndpointDirectory,
} from "@zhixing/mesh/bootstrap";
import type { TrustedMeshPeer } from "@zhixing/mesh/handshake";
import { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import type {
  AssignmentSubmissionPreflightPort,
  RuntimeFactory,
} from "@zhixing/owner-kernel";
import {
  FileConversationTransferStagingArea,
  ConversationTransferTarget,
  listConversationTransferStates,
} from "@zhixing/owner-kernel";
import type {
  ConversationAssignmentLedger,
  InProcessAssignmentSubmission,
} from "@zhixing/executor";
import type { AuthorityRuntimeStack } from "../setup-delivery.js";
import { AssignmentMeshComposition } from "./assignment-mesh-composition.js";
import { createAssignmentGlobalQueryPort } from "./assignment-schedule-stager.js";
import type { AssignmentArtifactAuthority } from "./assignment-mesh-adapter.js";
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
import { registerSurfaceAssetMeshService } from "./surface-asset-mesh.js";
import {
  AssignmentStreamMeshClient,
  createDataPlaneAssignmentStreamAuthorizer,
  registerAssignmentStreamService,
} from "./assignment-stream-mesh.js";
import {
  DataPlaneTicketMeshClient,
  registerDataPlaneTicketService,
} from "./data-plane-ticket-mesh.js";
import type { ExecutorDataPlaneRuntime } from "./executor-data-plane-runtime.js";
import type { JobSubmissionOwner } from "./job-assignment-worker.js";
import type { ExecutorJobOwner } from "./executor-job-owner.js";
import type { JobRelayObligationDirectory } from "./channel-interaction-coordinator.js";
import { AssignmentOperationsRouter } from "./assignment-operations-router.js";
import { JobInteractionRuntimeUnavailableError } from "./durable-job-interactions.js";
import {
  JobInteractionMeshClient,
  registerJobInteractionService,
} from "./job-interaction-mesh.js";
import {
  EnvironmentProbeMeshClient,
  registerEnvironmentProbeMeshService,
} from "./environment-probe-mesh.js";
import {
  EvidenceMeshClient,
  registerEvidenceMeshService,
} from "./evidence-mesh.js";
import type { LocalConversationOwnerAssembly } from "./local-conversation-owner.js";
import {
  ConversationTransferMeshClient,
  ConversationTransferRejectedError,
  registerConversationTransferMeshService,
} from "./conversation-transfer-mesh.js";
import type { PostAdoptionMemoryPort } from "./post-adoption-memory.js";
import {
  FirstPartyConversationMeshClient,
  FirstPartyConversationMeshTarget,
  registerFirstPartyConversationMeshService,
} from "./first-party-conversation-mesh.js";
import type { CanonicalFirstPartyConversationSurface } from "@zhixing/server";
import {
  FilePairedCheckpointStaging,
  PairedCheckpointReceiver,
  registerPairedCheckpointMeshService,
} from "@zhixing/mesh/paired-checkpoint-target";
import { FileRecoveryCheckpointTarget } from "@zhixing/mesh/checkpoint-target";
import { keyIdForPublicKey } from "@zhixing/mesh/recovery-root";

export interface PostAdoptionReviewPort {
  reviewAfterAdoption(conversationId: string): Promise<unknown>;
}

const MAX_ASSIGNMENT_ARTIFACT_BYTES = 512 * 1024 * 1024;

function routedSubmissionMeshRole(
  protocol: ConversationProtocolRuntime,
  jobRelays: JobRelayObligationDirectory | undefined,
): {
  readonly submission: RunSubmissionPort;
  readonly submissionGuard: AssignmentSubmissionPreflightPort;
} {
  const conversation = protocol.submissionMeshRole();
  const jobJournal = (context: AuthorityCallContext, assignmentId: string) => {
    const principal = context.principal;
    if (
      principal.kind !== "assignment" ||
      principal.capability.scope.execution !== "job" ||
      principal.capability.assignmentId !== assignmentId
    ) {
      throw new TypeError("Job submission requires its bound job assignment capability");
    }
    const journal = jobRelays?.submissionFor(assignmentId);
    if (!journal) {
      throw new JobInteractionRuntimeUnavailableError(
        `Job submission owner is not registered for ${assignmentId}`,
      );
    }
    return journal;
  };
  const isJob = (context: AuthorityCallContext) =>
    context.principal.kind === "assignment" &&
    context.principal.capability.scope.execution === "job";
  return {
    submission: {
      reportStarted: (assignmentId, context) =>
        isJob(context)
          ? jobJournal(context, assignmentId).reportStarted(assignmentId, context)
          : conversation.submission.reportStarted(assignmentId, context),
      submitBundle: (bundle, context) =>
        isJob(context)
          ? jobJournal(context, bundle.assignmentId).submitBundle(bundle, context)
          : conversation.submission.submitBundle(bundle, context),
      submitCancelProof: (assignmentId, proof, context) =>
        isJob(context)
          ? jobJournal(context, assignmentId).submitCancelProof(assignmentId, proof, context)
          : conversation.submission.submitCancelProof(assignmentId, proof, context),
      mirrorInteractions: (assignmentId, batch, context) =>
        isJob(context)
          ? jobJournal(context, assignmentId).mirrorInteractions(assignmentId, batch, context)
          : conversation.submission.mirrorInteractions(assignmentId, batch, context),
    },
    submissionGuard: {
      preflightSubmission: (context, identity) =>
        isJob(context)
          ? jobJournal(context, identity.assignmentId).preflightSubmission(context, identity)
          : conversation.submissionGuard.preflightSubmission(context, identity),
    },
  };
}

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
  readonly localConversationOwner?: LocalConversationOwnerAssembly;
  readonly jobRelays?: JobRelayObligationDirectory;
  readonly executor?: {
    readonly ledger: ConversationAssignmentLedger;
    readonly runtimeFactory: RuntimeFactory;
    readonly interactions: DurableConversationInteractionObserver;
    readonly dataPlane: ExecutorDataPlaneRuntime;
    readonly InProcessAssignmentSubmission: typeof InProcessAssignmentSubmission;
    readonly evidence?: EvidenceHandlerPort;
    /** Mesh 只注册 adapter；job worker 由稳定 executor role 组合根持有。 */
    readonly job?: {
      readonly owner: ExecutorJobOwner;
    };
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
  readonly #transferTarget: ConversationTransferTarget | undefined;
  readonly #firstPartyConversationTarget: FirstPartyConversationMeshTarget | undefined;
  readonly #transferAbort = new AbortController();
  readonly #disposers: Array<() => void> = [];
  #postAdoptionMemory: PostAdoptionMemoryPort | undefined;
  #postAdoptionReview: PostAdoptionReviewPort | undefined;
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
    const anchorGlobalState = roles.has("anchor")
      ? options.authority.globalState ?? (() => {
          throw new Error("Anchor mesh role requires the global authority state port");
        })()
      : undefined;
    const receiver = new FileResumableArtifactReceiver(
      options.authority.artifacts,
      path.join(options.zhixingHome, "distributed-runtime", "mesh-artifact-partials"),
      { maxArtifactBytes: MAX_ASSIGNMENT_ARTIFACT_BYTES },
    );
    let worker: ConversationAssignmentWorker | undefined;
    const jobOwner = options.executor?.job?.owner;
    const executorPort: RunExecutorPort | undefined = roles.has("executor")
      ? {
          dispatch: (...args) => {
            const [envelope] = args;
            if (
              envelope.execution === "job" &&
              (!jobOwner || !jobOwner.ready)
            ) {
              throw new JobInteractionRuntimeUnavailableError(
                "This executor has no enabled job runtime",
              );
            }
            return (options.executor!.ledger as RunExecutorPort).dispatch(
              ...args,
            );
          },
          cancel: async (assignmentId, fence, context) => {
            const jobPhase =
              await options.executor!.ledger.jobAssignmentPhaseForRecovery(
                assignmentId,
              );
            if (jobPhase !== undefined) {
              if (!jobOwner || !jobOwner.ready) {
                throw new JobInteractionRuntimeUnavailableError(
                  "Job cancellation has no enabled executor-owned job runtime",
                );
              }
              await options.executor!.ledger.beginOwnerCancellation(
                assignmentId,
                fence,
                context,
              );
              await jobOwner.cancelAccepted(assignmentId);
              await options.executor!.ledger.finishOwnerCancellation(
                assignmentId,
                fence,
                context,
              );
              return;
            }
            await options.executor!.ledger.cancel(assignmentId, fence, context);
            worker?.abort(
              assignmentId,
              new Error("Conversation assignment was cancelled"),
            );
          },
          supersede: (assignmentId, fence, context) =>
            options.executor!.ledger.supersede(assignmentId, fence, context),
          queryLedger: (assignmentId, context, range) =>
            options.executor!.ledger.queryLedger(
              assignmentId,
              context,
              range,
            ),
        }
      : undefined;
    const executorRole = executorPort
      ? {
          port: executorPort,
          guard: options.executor!.ledger,
          artifactAuthorizationFor: (assignmentId: string) =>
            options.executor!.ledger.assignmentArtifactAuthority(assignmentId),
        }
      : undefined;
    const anchorRole = roles.has("anchor")
      ? {
          ...routedSubmissionMeshRole(options.protocol!, options.jobRelays),
          globalState: anchorGlobalState!,
        }
      : undefined;
    this.#transferTarget = roles.has("anchor")
      ? new ConversationTransferTarget({
          deviceId: options.authority.deviceId,
          log: options.authority.authorityLog,
          artifacts: options.authority.artifacts,
          staging: new FileConversationTransferStagingArea(
            path.join(path.dirname(options.authority.artifacts.rootDir), "conversation-transfer-staging"),
          ),
          storageMaintenance: options.authority.storageMaintenance,
          abortSignal: () => this.#transferAbort.signal,
          signer: options.authority.signer,
          verifier: options.authority.verifier,
          isActiveSource: (deviceId) => this.#peerHasRole(deviceId, "executor"),
          acceptsSourceConversationId: (deviceId, conversationId) => {
            assertLocalConversationIdForDevice(conversationId, deviceId);
            return true;
          },
          conversationExists: (conversationId) => options.protocol!.sessionExists(conversationId),
          sourceOwnerEpoch: () => undefined,
          reducerVersion: "conversation-session-state-v1",
          preparePublication: (base) =>
            options.protocol!.prepareCommittedConversationTransfer(base),
        })
      : undefined;
    this.#firstPartyConversationTarget = roles.has("anchor")
      ? new FirstPartyConversationMeshTarget()
      : undefined;
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
              onDispatchAccepted: (envelope) => {
                if (envelope.execution === "conversation") {
                  worker?.accept(envelope);
                } else {
                  jobOwner?.accept(envelope);
                }
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
        preflightEnvironment: (manifest, assignmentId) =>
          options.authority.takeLocalConversationEnvironmentPreflight(
            manifest,
            assignmentId,
          ),
        releasePreflightEnvironment: (manifest, assignmentId) =>
          options.authority.releaseLocalConversationEnvironmentPreflight(
            manifest,
            assignmentId,
          ),
        artifacts: options.authority.artifacts,
        submissionFor: () => this.#composition.submissionPort(anchorId),
        globalQueryFor: (capability, anchorEpoch) =>
          roles.has("anchor")
            ? createAssignmentGlobalQueryPort({
                state: anchorGlobalState!,
                capability,
                anchorEpoch,
              })
            : this.#composition.globalQueryPort(anchorId, capability, anchorEpoch),
        resourceGovernor: options.authority.executorResourceGovernor,
        InProcessAssignmentSubmission:
          options.executor!.InProcessAssignmentSubmission,
        interactions: options.executor!.interactions,
        createStream: (input) =>
          options.executor!.dataPlane.createStream(input),
        finalizeUsage: ({ assignmentId }) => this.finalizeExecutorUsage(assignmentId),
        onError: (_assignmentId, error) => options.onError?.(error),
      });
    }
    this.#worker = worker;

    if (roles.has("executor")) {
      const dataPlane = options.executor!.dataPlane;
      const operations = new AssignmentOperationsRouter({
        ledger: options.executor!.ledger,
        conversation: worker!,
        ...(jobOwner ? { job: jobOwner } : {}),
      });
      const surfacePrincipalFor = (connection: import("@zhixing/mesh").SecureMeshConnection) =>
        `surface:device:${connection.peer.deviceId}`;
      this.#disposers.push(
        registerAssignmentStreamService(this.services, {
          spool: dataPlane.spool,
          authorize: createDataPlaneAssignmentStreamAuthorizer({
            tickets: dataPlane.tickets,
            surfacePrincipalFor,
            ownerMayPresentSurfaceTicket: (connection) =>
              connection.peer.deviceId === options.trust.issuer.deviceId &&
              this.#peerHasRole(connection.peer.deviceId, "anchor"),
            authorizeOwnerRelay: async (request) => {
              if (request.consumer.kind !== "owner-relay") {
                throw new TypeError("Owner relay authorization has the wrong consumer kind");
              }
              await options.executor!.dataPlane.authorizeOwnerRelayConsumer({
                assignmentId: request.assignmentId,
                consumer: request.consumer,
                ownerDeviceId: request.connection.peer.deviceId,
              });
              return {};
            },
          }),
          authorizePeer: (deviceId) =>
            this.#peerHasRole(deviceId, "anchor") ||
            this.#peerHasRole(deviceId, "surface"),
        }),
      );
      this.#disposers.push(
        registerDataPlaneTicketService(this.services, {
          tickets: dataPlane.tickets,
          verifier: options.authority.verifier,
          operations,
          authorizeOwner: (connection) =>
            connection.peer.deviceId === options.trust.issuer.deviceId &&
            this.#peerHasRole(connection.peer.deviceId, "anchor"),
          surfacePrincipalFor,
          authorizePeer: (deviceId) =>
            this.#peerHasRole(deviceId, "anchor") ||
            this.#peerHasRole(deviceId, "surface"),
        }),
      );
      this.#disposers.push(registerExecutionSnapshotMeshService(
        this.services,
        {
          currentCapability: options.authority.currentExecutorSnapshot,
          installPermission: options.authority.installPermissionSnapshot,
          installAssets: options.authority.installExecutionAssetBundle,
        },
        (deviceId) => this.#peerHasRole(deviceId, "anchor"),
        options.authority.verifier,
      ));
      if (options.authority.workspaceProbe) {
        this.#disposers.push(
          registerEnvironmentProbeMeshService(
            this.services,
            options.authority.workspaceProbe,
            options.authority.verifier,
            (deviceId) =>
              deviceId === options.trust.issuer.deviceId &&
              this.#peerHasRole(deviceId, "anchor"),
          ),
        );
      }
      if (options.executor!.evidence) {
        this.#disposers.push(
          registerEvidenceMeshService(
            this.services,
            options.executor!.evidence,
            options.authority.verifier,
            (deviceId) =>
              deviceId === options.trust.issuer.deviceId &&
              this.#peerHasRole(deviceId, "anchor"),
          ),
        );
      }
      if (options.executor!.job) {
        this.#disposers.push(
          registerJobInteractionService(this.services, {
            answers: jobOwner!,
            verifier: options.authority.verifier,
            authorizeOwner: (connection) =>
              connection.peer.deviceId === options.trust.issuer.deviceId &&
              this.#peerHasRole(connection.peer.deviceId, "anchor"),
            authorizePeer: (deviceId) => this.#peerHasRole(deviceId, "anchor"),
          }),
        );
      }
    }

    if (roles.has("anchor")) {
      this.#disposers.push(
        registerSurfaceAssetMeshService(this.services, {
          coordinator: options.authority.surfaceAssets,
          verifier: options.authority.verifier,
          surfacePrincipalFor: (connection) =>
            `surface:device:${connection.peer.deviceId}`,
          authorizePeer: (deviceId) =>
            this.#peerHasRole(deviceId, "surface"),
        }),
      );
    }

    if (this.#transferTarget || options.localConversationOwner) {
      this.#disposers.push(
        registerConversationTransferMeshService(this.services, {
          ...(options.localConversationOwner
            ? { source: options.localConversationOwner.transferSource() }
            : {}),
          ...(this.#transferTarget ? { target: this.#transferTarget } : {}),
          signer: options.authority.signer,
          verifier: options.authority.verifier,
          clientFor: (deviceId) => this.connections.client(deviceId),
          authorizePeer: (deviceId) =>
            this.#peerHasRole(deviceId, "anchor") || this.#peerHasRole(deviceId, "executor"),
          ...(this.#transferTarget
            ? {
                afterCommit: async (base) => {
                  await this.#installCommittedTransfer(base);
                },
                onBackgroundError: (error) => options.onError?.(error),
              }
            : {}),
        }),
      );
    }

    if (this.#firstPartyConversationTarget) {
      this.#disposers.push(registerFirstPartyConversationMeshService(
        this.services,
        this.#firstPartyConversationTarget,
        (deviceId) => this.#peerHasRole(deviceId, "executor"),
      ));
    }

    if (
      options.trust.recoveryBackupPublicKey &&
      options.trust.issuer.deviceId !== options.authority.deviceId &&
      options.trust.members.some((member) =>
        member.device.deviceId === options.authority.deviceId && member.state === "active")
    ) {
      const pairedTarget = deferredPairedCheckpointTarget({
        zhixingHome: options.zhixingHome,
        deviceId: options.authority.deviceId,
        storageMaintenance: options.authority.storageMaintenance,
      });
      this.#disposers.push(registerPairedCheckpointMeshService(
        this.services,
        new PairedCheckpointReceiver({
          homeId: options.trust.homeId,
          sourceDeviceId: options.trust.issuer.deviceId,
          targetDeviceId: options.authority.deviceId,
          recipientKeyId: keyIdForPublicKey(options.trust.recoveryBackupPublicKey),
          staging: new FilePairedCheckpointStaging({
            root: path.join(options.zhixingHome, "distributed-runtime", "recovery-checkpoint-incoming"),
            target: pairedTarget,
            storageMaintenance: options.authority.storageMaintenance,
          }),
        }),
        (deviceId) =>
          deviceId === options.trust.issuer.deviceId &&
          this.#peerHasRole(deviceId, "anchor"),
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
      onTrustReconciled: async (record) => {
        options.authority.reconcileTrustedDevices(
          record.members.map((member) => member.device),
          record.members
            .filter((member) => member.state === "active")
            .map((member) => member.device.deviceId),
        );
        if (roles.has("anchor")) {
          for (const member of record.members) {
            if (
              member.state !== "active" ||
              !member.roles.includes("surface")
            ) {
              await options.authority.surfaceAssets.revokeSurface(
                `surface:device:${member.device.deviceId}`,
              );
            }
          }
        }
      },
      onConnection: async (connection) => {
        await fulfillConnectionLifetimeObligation({
          connectionClosed: connection.closed,
          attempt: async () => {
            await this.#finalizePairingBootstrap(connection.peer.deviceId);
            await this.#adoptLocalConversations(connection.peer.deviceId);
          },
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

  /** Executor role 组合根用它绑定 owner submission；mesh 本身不持有 worker 生命周期。 */
  submissionForAnchor(): JobSubmissionOwner {
    return this.#composition.submissionPort(this.options.trust.issuer.deviceId);
  }

  globalQueryForAnchor(
    capability: import("@zhixing/core/contracts").AuthorityCapability,
    anchorEpoch: number,
  ): import("@zhixing/core/contracts").AssignmentGlobalQueryPort {
    return this.#composition.globalQueryPort(
      this.options.trust.issuer.deviceId,
      capability,
      anchorEpoch,
    );
  }

  /** Binds the anchor-only consumer and catches up every durable commit. */
  async bindPostAdoptionMemory(port: PostAdoptionMemoryPort): Promise<void> {
    if (!this.#transferTarget || !this.options.protocol) {
      throw new Error("Post-adoption memory requires the anchor transfer target");
    }
    if (this.#postAdoptionMemory && this.#postAdoptionMemory !== port) {
      throw new Error("Post-adoption memory is already bound");
    }
    this.#postAdoptionMemory = port;
    await this.#restoreCommittedTransfers();
  }

  /** Binds the anchor review seam and catches up every durable commit. */
  async bindPostAdoptionReview(port: PostAdoptionReviewPort): Promise<void> {
    if (!this.#transferTarget || !this.options.protocol) {
      throw new Error("Post-adoption review requires the anchor transfer target");
    }
    if (this.#postAdoptionReview && this.#postAdoptionReview !== port) {
      throw new Error("Post-adoption review is already bound");
    }
    this.#postAdoptionReview = port;
    await this.#restoreCommittedTransfers();
  }

  bindFirstPartyConversationSurface(surface: CanonicalFirstPartyConversationSurface): void {
    if (!this.#firstPartyConversationTarget) {
      throw new Error("First-party conversation surface requires the anchor transfer target");
    }
    this.#firstPartyConversationTarget.bind(surface);
  }

  firstPartyConversationFor(deviceId: string): FirstPartyConversationMeshClient {
    return new FirstPartyConversationMeshClient(
      this.connections.client(deviceId),
      this.options.authority.deviceId,
      (error) => this.options.onError?.(error),
    );
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error("Mesh runtime assembly is closed");
    if (this.#started) return;
    try {
      await this.#restoreCommittedTransfers();
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
    this.#transferAbort.abort(new Error("Conversation transfer runtime is stopping"));
    this.#worker?.stopAccepting();
    await this.#control.stop();
    await this.#worker?.close();
    this.#firstPartyConversationTarget?.close();
    this.#composition.close();
    for (const dispose of this.#disposers.splice(0).reverse()) dispose();
  }

  dataPlaneForExecutor(executorId: string): {
    readonly stream: AssignmentStreamMeshClient;
    readonly tickets: DataPlaneTicketMeshClient;
  } {
    const deviceId = this.#activeExecutorDeviceId(executorId);
    const client = this.connections.client(deviceId);
    return {
      stream: new AssignmentStreamMeshClient(client),
      tickets: new DataPlaneTicketMeshClient(client),
    };
  }

  /** owner 侧获取指定 executor 的 job 答复转交客户端(JobRelayOpening.answers)。 */
  jobInteractionForExecutor(executorId: string): JobInteractionMeshClient {
    const deviceId = this.#activeExecutorDeviceId(executorId);
    return new JobInteractionMeshClient(this.connections.client(deviceId));
  }

  /** Remote job candidates use the same authenticated executor links as conversations. */
  async jobExecutionTargets(): Promise<readonly {
    readonly executorId: string;
    readonly deviceId: string;
    readonly synchronizePermission: RemoteConversationExecutionTarget["synchronizePermission"];
  }[]> {
    const directory = this.#remoteDirectory();
    return (await directory.candidates()).map((target) => ({
      executorId: target.executorId,
      deviceId: target.deviceId,
      synchronizePermission: (snapshot, executionAssets) =>
        target.synchronizePermission(snapshot, executionAssets),
    }));
  }

  /** Owner-side job dispatcher for one authenticated remote executor. */
  jobExecutorFor(
    executorId: string,
    authorizationFor: (
      assignmentId: string,
    ) => Promise<AssignmentArtifactAuthority>,
  ): RunExecutorPort {
    const deviceId = this.#activeExecutorDeviceId(executorId);
    return this.#composition.executorPort(deviceId, {
      verifier: this.options.authority.verifier,
      authorizationFor,
    });
  }

  workspaceProbeForDevice(deviceId: string): EnvironmentProbeMeshClient {
    if (
      !this.#peerHasRole(deviceId, "executor") ||
      !this.connections.has(deviceId)
    ) {
      throw new Error(`Workspace probe executor is unavailable: ${deviceId}`);
    }
    return new EnvironmentProbeMeshClient(
      this.connections.client(deviceId),
      this.options.authority.verifier,
    );
  }

  /** local 与 mesh 共用同一 EvidenceHandlerPort 合同和业务实现。 */
  evidenceForExecutor(executorId: string): EvidenceHandlerPort {
    if (
      executorId === this.options.authority.executorId &&
      this.options.executor?.evidence
    ) {
      return this.options.executor.evidence;
    }
    const deviceId = this.#activeExecutorDeviceId(executorId);
    return new EvidenceMeshClient(
      this.connections.client(deviceId),
      this.options.authority.verifier,
    );
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
        deviceId,
        executor: this.#composition.executorPort(deviceId, {
          verifier: this.options.authority.verifier,
          authorizationFor: (assignmentId) =>
            this.options.protocol!.assignmentArtifactAuthority(assignmentId),
        }),
        synchronizePermission: (snapshot, executionAssets) =>
          snapshots.installPermission(snapshot, executionAssets),
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

  #activeExecutorDeviceId(executorId: string): string {
    const deviceId = this.#control.currentTrust().members
      .filter(
        (member) =>
          member.state === "active" &&
          member.roles.includes("executor"),
      )
      .map((member) => member.device.deviceId)
      .find((candidate) => executorIdForDevice(candidate) === executorId);
    if (!deviceId || !this.connections.has(deviceId)) {
      throw new Error(`Executor data plane is unavailable: ${executorId}`);
    }
    return deviceId;
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

  async #restoreCommittedTransfers(): Promise<void> {
    if (!this.#transferTarget || !this.options.protocol) return;
    const states = await listConversationTransferStates(
      this.options.authority.authorityLog,
      this.options.authority.verifier,
    );
    for (const state of states) {
      if (state.phase !== "committed" && state.phase !== "tombstoned") continue;
      const base = await this.#transferTarget.committedBase(state.identity.transferId);
      await this.#installCommittedTransfer(base);
    }
  }

  async #installCommittedTransfer(base: {
    readonly manifest: import("@zhixing/core/contracts").ConversationTransferManifest;
    readonly records: readonly import("@zhixing/owner-kernel").ConversationTransferAuthorityRecord[];
  }): Promise<void> {
    const protocol = this.options.protocol;
    if (!protocol) throw new Error("Conversation transfer target has no owner protocol");
    await protocol.installCommittedConversationTransfer(base);
    await Promise.all([
      this.#postAdoptionMemory
        ? this.#postAdoptionMemory.flush({
            manifest: base.manifest,
            loadCandidates: () => protocol.conversationMemoryFlushes(
              base.manifest.conversationId,
            ),
          })
        : Promise.resolve(),
      this.#postAdoptionReview
        ? this.#postAdoptionReview.reviewAfterAdoption(base.manifest.conversationId)
        : Promise.resolve(),
    ]);
  }

  async #adoptLocalConversations(peerDeviceId: string): Promise<void> {
    const owner = this.options.localConversationOwner;
    if (
      !owner ||
      peerDeviceId !== this.options.trust.issuer.deviceId ||
      !this.#peerHasRole(peerDeviceId, "anchor")
    ) {
      return;
    }
    const identity = owner.transferIdentity();
    const source = owner.transferSource();
    const client = new ConversationTransferMeshClient(
      this.connections.client(peerDeviceId),
      this.options.authority.signer,
      this.options.authority.verifier,
    );
    const states = await listConversationTransferStates(
      this.options.authority.executorLog,
      this.options.authority.verifier,
    );
    for (const conversationId of await owner.transferCandidates()) {
      const parsed = parseLocalConversationId(conversationId);
      if (!parsed) continue;
      const prior = states.find((state) =>
        state.identity.conversationId === conversationId &&
        state.identity.targetDeviceId === peerDeviceId &&
        state.phase !== "aborted"
      );
      if (prior?.phase === "committed" || prior?.phase === "tombstoned") continue;
      const transferId = prior?.identity.transferId ?? `xfer-${parsed.ulid}`;
      const requestId = prior?.identity.requestId ?? `adopt:${conversationId}`;
      const prepared = {
        v: 1 as const,
        t: "prepared" as const,
        requestId,
        transferId,
        sourceDeviceId: identity.deviceId,
        targetDeviceId: peerDeviceId,
        conversationId,
        sourceOwnerEpoch: identity.ownerEpoch,
        nextOwnerEpoch: identity.ownerEpoch + 1,
      };
      try {
        const resumedTarget = prior ? await client.status(transferId).catch(() => undefined) : undefined;
        if (resumedTarget?.state === "committed" || resumedTarget?.state === "tombstoned") {
          if (!resumedTarget.commit) {
            throw new Error("Committed transfer recovery is incomplete");
          }
          const frozen = await source.freeze(transferId);
          await source.acceptCommit({ manifest: frozen.manifest, commit: resumedTarget.commit });
          continue;
        }
        if (resumedTarget?.state === "aborted") {
          await source.acceptAbort(resumedTarget.abort);
          continue;
        }
        if (!prior) {
          await client.prepare(prepared);
          await source.prepare({
            requestId,
            transferId,
            targetDeviceId: peerDeviceId,
            conversationId,
            sourceOwnerEpoch: identity.ownerEpoch,
          });
        }
        const frozen = await source.freeze(transferId);
        const commit = await client.importAndCommit(frozen);
        await source.acceptCommit({ manifest: frozen.manifest, commit });
      } catch (error) {
        const durable = await listConversationTransferStates(
          this.options.authority.executorLog,
          this.options.authority.verifier,
        ).then((items) => items.find((item) => item.identity.transferId === transferId));
        if (!durable) continue;
        const target = await client.status(transferId).catch(() => undefined);
        if (target?.state === "committed" || target?.state === "tombstoned") {
          if (!target.commit || !durable.manifest) throw new Error("Committed transfer recovery is incomplete");
          const manifest = await source.freeze(transferId);
          await source.acceptCommit({ manifest: manifest.manifest, commit: target.commit });
          continue;
        }
        if (target?.state === "aborted") {
          await source.acceptAbort(target.abort);
          continue;
        }
        if (!(error instanceof ConversationTransferRejectedError) || error.retryable) {
          throw error;
        }
        const abort = await source.prepareAbort(transferId, "target-rejected");
        const acknowledged = await client.abort(abort);
        await source.acceptAbort(acknowledged);
      }
    }
  }


  #peerHasRole(deviceId: string, role: DeviceRole): boolean {
    return this.#control.currentTrust().members.some((member) =>
      member.device.deviceId === deviceId &&
      member.state === "active" &&
      member.roles.includes(role));
  }
}

function deferredPairedCheckpointTarget(input: {
  readonly zhixingHome: string;
  readonly deviceId: string;
  readonly storageMaintenance?: import("@zhixing/core/resources").StorageMaintenanceGovernorPort;
}): import("@zhixing/mesh/checkpoint-target").RetirableRecoveryCheckpointTarget {
  const open = () => FileRecoveryCheckpointTarget.openPaired({
    targetRoot: path.join(input.zhixingHome, "distributed-runtime", "recovery-checkpoints"),
    targetDeviceId: input.deviceId,
    ...(input.storageMaintenance ? { storageMaintenance: input.storageMaintenance } : {}),
  });
  const use = async <T>(operation: (target: FileRecoveryCheckpointTarget) => Promise<T>): Promise<T> => {
    const target = await open();
    try {
      return await operation(target);
    } finally {
      await target.close();
    }
  };
  return {
    targetId: `backup-device:${input.deviceId}`,
    independenceDomain: `device:${input.deviceId}`,
    writeDurable: (checkpoint) => use((target) => target.writeDurable(checkpoint)),
    read: async (checkpointId, signal) => {
      const initial = await use((target) => target.read(checkpointId, signal));
      // Legacy trust-only checkpoints are deliberately materialized within a strict cap.
      if (initial.chunks) return initial;
      return {
        envelope: initial.envelope,
        source: {
          read: (seq, offset, limit, rangeSignal) => use(async (target) => {
            const current = await target.read(checkpointId, rangeSignal ?? signal);
            if (!current.source) throw new TypeError("Paired checkpoint source is unavailable");
            return current.source.read(seq, offset, limit, rangeSignal ?? signal);
          }),
        },
      };
    },
    retire: async (checkpointId, supersededBy) =>
      use((target) => target.retire(checkpointId, supersededBy)),
  };
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
