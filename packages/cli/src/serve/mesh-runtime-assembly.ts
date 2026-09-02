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
  CheckpointStreamRecord,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  type DeviceLifecycleAbort,
  type ExecutorRemovalLifecycleIdentity,
  type ExecutorRemovalReceipt,
} from "@zhixing/core/protocol";
import {
  MeshConnectionRegistry,
  MeshEndpointDirectory,
  type MeshConnectionProjectionPort,
} from "@zhixing/mesh/bootstrap";
import type { TrustedMeshPeer } from "@zhixing/mesh/handshake";
import type { DeviceKey } from "@zhixing/mesh/device-identity";
import { loadActiveAnchorIssuerKey } from "@zhixing/mesh/device-key-store";
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
import {
  INSTALLED_AUTHORITY_GENERATION_PARTICIPANTS,
  type AuthorityRuntimeStack,
  type InstalledAuthorityGenerationReceipt,
} from "../setup-delivery.js";
import { AssignmentMeshComposition } from "./assignment-mesh-composition.js";
import { createAssignmentGlobalQueryPort } from "./assignment-schedule-stager.js";
import type { AssignmentArtifactAuthority } from "./assignment-mesh-adapter.js";
import { fulfillConnectionLifetimeObligation } from "./connection-lifetime-obligation.js";
import { ConversationAssignmentWorker } from "./conversation-assignment-worker.js";
import type { ConversationProtocolRuntime } from "./conversation-protocol-runtime.js";
import type {
  ConversationExecutorTopologyAdapter,
  ConversationExecutorTopologyDirectory,
  ConversationExecutorTopologyTarget,
} from "./conversation-executor-dispatch.js";
import type { DurableConversationInteractionObserver } from "./durable-conversation-interactions.js";
import {
  MeshExecutionSnapshotClient,
  registerExecutionSnapshotMeshService,
} from "./execution-snapshot-mesh.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { FileMeshPairingContinuationStore } from "./mesh-pairing-continuation.js";
import { ProductionMeshControlPlane } from "./mesh-control-plane.js";
import { CredentialExposureAuthority } from "./credential-exposure-authority.js";
import { registerSurfaceAssetMeshService } from "./surface-asset-mesh.js";
import {
  AssignmentStreamMeshClient,
} from "./assignment-stream-mesh.js";
import {
  DataPlaneTicketMeshClient,
} from "./data-plane-ticket-mesh.js";
import type {
  AssignmentDataPlaneMeshPort,
  AssignmentDataPlaneRemoteDirectory,
  AssignmentDataPlaneTarget,
} from "./assignment-data-plane-topology.js";
import type { AdvancementEvidenceRemoteDirectory } from "./advancement-evidence-topology.js";
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
import type {
  LocalConversationOwnerAssembly,
  LocalConversationRemovalSnapshot,
} from "./local-conversation-owner.js";
import {
  ConversationTransferMeshClient,
  ConversationTransferRejectedError,
  registerConversationTransferMeshService,
} from "./conversation-transfer-mesh.js";
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
import { keyIdForPublicKey } from "@zhixing/mesh/recovery-root";
import { deferredPairedCheckpointTarget } from "./paired-checkpoint-runtime.js";
import { commitRecoveryRootLifecycleActivation } from "./recovery-root-activation.js";
import {
  completePlannedAnchorInstallationBeforeBootstrap,
  finishPlannedAnchorPostInstall,
  readBackPlannedAnchorPostInstallObligations,
  PlannedAnchorTransferOwner,
  PlannedAnchorTransferRuntimeLifecycle,
  PlannedAnchorTransferTarget,
  type PlannedAnchorPostInstallDescriptor,
  type InstalledAuthorityGeneration,
} from "./planned-anchor-transfer.js";
import {
  PlannedAnchorTransferMeshClient,
  reconcilePlannedAnchorTrustFromPeer,
  registerPlannedAnchorTrustReconciliationService,
  registerPlannedAnchorTransferMeshServices,
  registerPlannedAnchorTransferSourceMeshService,
} from "./planned-anchor-transfer-mesh.js";
import type { AuthorityCheckpointOwnerPort } from "@zhixing/mesh/checkpoint-owner";
import type { PlannedAnchorTransferLifecycle } from "./planned-anchor-transfer.js";
import {
  completeDisasterRecoveryInstallationBeforeBootstrap,
  finishDisasterRecoveryPostInstall,
  type DisasterRecoveryPostInstallDescriptor,
} from "./disaster-recovery-target.js";
import { registerDisasterRecoveryTrustEvidenceService } from "./disaster-recovery-trust-evidence.js";
import {
  CurrentIssuerDeviceRemovalAuthority,
  ExecutorRemovalTarget,
  type ExecutorRemovalPublicState,
} from "./device-removal.js";
import {
  DeviceRemovalIssuerMeshClient,
  DeviceRemovalTargetMeshClient,
  registerDeviceRemovalIssuerMeshService,
  registerDeviceRemovalTargetMeshService,
} from "./device-removal-mesh.js";

type AnchorPostInstallDescriptor =
  | PlannedAnchorPostInstallDescriptor
  | DisasterRecoveryPostInstallDescriptor;

export interface PostAdoptionReviewPort {
  reviewAfterAdoption(conversationId: string): Promise<unknown>;
}

export interface PlannedAnchorPostInstallConsumers {
  readonly rebindAuthorityGeneration: (
    generation: InstalledAuthorityGeneration,
  ) => Promise<InstalledAuthorityGenerationReceipt>;
  readonly recoverScheduler: (
    obligations: readonly { readonly kind: "assignment" | "intent"; readonly id: string }[],
  ) => Promise<readonly { readonly kind: "assignment" | "intent"; readonly id: string }[]>;
  readonly recoverConversation: (
    obligations: readonly {
      readonly kind: "interaction" | "confirmation" | "final";
      readonly id: string;
    }[],
  ) => Promise<readonly {
    readonly kind: "interaction" | "confirmation" | "final";
    readonly id: string;
  }[]>;
  readonly recoverDelivery: (
    obligations: readonly { readonly kind: "delivery"; readonly id: string }[],
  ) => Promise<readonly { readonly kind: "delivery"; readonly id: string }[]>;
  readonly openCurrentOwnerSurfaces: () => Promise<void>;
}

export interface PlannedAnchorPostInstallGroups {
  readonly scheduler: readonly {
    readonly kind: "assignment" | "intent";
    readonly id: string;
  }[];
  readonly conversation: readonly {
    readonly kind: "interaction" | "confirmation" | "final";
    readonly id: string;
  }[];
  readonly delivery: readonly {
    readonly kind: "delivery";
    readonly id: string;
  }[];
}

function assertPlannedAnchorConsumerReceipt(
  expected: readonly { readonly kind: string; readonly id: string }[],
  actual: readonly { readonly kind: string; readonly id: string }[],
  consumer: string,
): void {
  if (
    actual.length !== expected.length ||
    actual.some((item, index) =>
      item.kind !== expected[index]?.kind || item.id !== expected[index]?.id
    )
  ) {
    throw new Error(`Installed migration ${consumer} consumer receipt changed its obligation exact-set`);
  }
}

/** Single finite partition consumed by startup and live planned completion. */
export function partitionPlannedAnchorPostInstall(
  obligations: PlannedAnchorPostInstallDescriptor["pendingObligations"],
): PlannedAnchorPostInstallGroups {
  const scheduler: Array<{ kind: "assignment" | "intent"; id: string }> = [];
  const conversation: Array<{
    kind: "interaction" | "confirmation" | "final";
    id: string;
  }> = [];
  const delivery: Array<{ kind: "delivery"; id: string }> = [];
  for (const obligation of obligations) {
    if (obligation.kind === "assignment" || obligation.kind === "intent") {
      scheduler.push({ kind: obligation.kind, id: obligation.id });
    } else if (
      obligation.kind === "interaction" ||
      obligation.kind === "confirmation" ||
      obligation.kind === "final"
    ) {
      conversation.push({ kind: obligation.kind, id: obligation.id });
    } else {
      delivery.push({ kind: obligation.kind, id: obligation.id });
    }
  }
  return Object.freeze({
    scheduler: Object.freeze(scheduler),
    conversation: Object.freeze(conversation),
    delivery: Object.freeze(delivery),
  });
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
  readonly plannedAnchorIssuerKey?: DeviceKey;
  readonly plannedAnchorPostInstall?: AnchorPostInstallDescriptor;
  readonly authority: AuthorityRuntimeStack;
  readonly protocol?: ConversationProtocolRuntime;
  readonly executorTopology?: ConversationExecutorTopologyAdapter;
  readonly localConversationOwner?: LocalConversationOwnerAssembly;
  readonly jobRelays?: JobRelayObligationDirectory;
  readonly executor?: {
    readonly ledger: ConversationAssignmentLedger;
    readonly runtimeFactory: RuntimeFactory;
    readonly interactions: DurableConversationInteractionObserver;
    readonly dataPlane: AssignmentDataPlaneMeshPort;
    readonly InProcessAssignmentSubmission: typeof InProcessAssignmentSubmission;
    readonly evidence?: EvidenceHandlerPort;
    /** Mesh 只注册 adapter；job worker 由稳定 executor role 组合根持有。 */
    readonly job?: {
      readonly owner: ExecutorJobOwner;
    };
  };
  readonly secretStore: import("@zhixing/core/contracts").SecretStorePort;
  readonly connectionProjection?: MeshConnectionProjectionPort;
  readonly onError?: (error: Error) => void;
  readonly onTrustApplied?: (record: HomeTrustRecord) => void | Promise<void>;
}

/** Production composition for authenticated control services and their durable role owners. */
export class MeshRuntimeAssembly
  implements AssignmentDataPlaneRemoteDirectory, AdvancementEvidenceRemoteDirectory {
  readonly services = new MeshServiceRegistry();
  readonly #terminalOnlyServices = new MeshServiceRegistry();
  readonly connections: MeshConnectionRegistry;
  readonly #composition: AssignmentMeshComposition;
  readonly #control: ProductionMeshControlPlane;
  readonly #worker: ConversationAssignmentWorker | undefined;
  readonly #transferTarget: ConversationTransferTarget | undefined;
  readonly #firstPartyConversationTarget: FirstPartyConversationMeshTarget | undefined;
  readonly #transferAbort = new AbortController();
  readonly #plannedTransferRuntime = new PlannedAnchorTransferRuntimeLifecycle();
  readonly #disposers: Array<() => void> = [];
  readonly #deviceRemovalGuards = new Map<string, string>();
  #deviceRemovalAuthority: CurrentIssuerDeviceRemovalAuthority | undefined;
  #disposeDeviceRemovalIssuer: (() => void) | undefined;
  #deviceRemovalIssuerKeyId: string | undefined;
  readonly #deviceRemovalTarget: ExecutorRemovalTarget;
  #deviceRemovalCleanup?: (
    operationId: string,
  ) => Promise<readonly import("@zhixing/core/protocol").DeviceLifecycleEvidenceRef[]>;
  #deviceRemovalRemoved?: (operationId: string) => void | Promise<void>;
  #deviceRemovalFinalizeKey?: (
    operationId: string,
    identity: import("@zhixing/core/protocol").ExecutorRemovalLifecycleIdentity,
  ) => Promise<readonly import("@zhixing/core/protocol").DeviceLifecycleEvidenceRef[]>;
  #deviceRemovalCloseAdmission?: (operationId: string) => Promise<void>;
  #deviceRemovalCaptureAcceptedWork?: (
    operationId: string,
  ) => Promise<LocalConversationRemovalSnapshot["ownerItems"]>;
  #deviceRemovalSettleAcceptedWork?: (input: {
    readonly operationId: string;
    readonly mode: "transfer" | "destroy";
    readonly ownerItems: LocalConversationRemovalSnapshot["ownerItems"];
  }) => Promise<void>;
  #deviceRemovalReleaseAdmission?: (operationId: string) => Promise<void>;
  #localDeviceRemovalOperation: string | undefined;
  #plannedAnchorOwner: PlannedAnchorTransferOwner | undefined;
  #plannedAnchorTarget: PlannedAnchorTransferTarget | undefined;
  #disposePlannedAnchorTarget: (() => void) | undefined;
  #disposePlannedAnchorSource: (() => void) | undefined;
  #plannedAnchorRole = "";
  #plannedAnchorCheckpointOwner: AuthorityCheckpointOwnerPort | undefined;
  #plannedAnchorLifecycle: PlannedAnchorTransferLifecycle | undefined;
  #plannedAnchorIssuerKey: DeviceKey | undefined;
  #plannedAnchorPostInstall: AnchorPostInstallDescriptor | undefined;
  #plannedAnchorPostInstallConsumers: PlannedAnchorPostInstallConsumers | undefined;
  #plannedCommittedTargetDeviceId: string | undefined;
  #postAdoptionReview: PostAdoptionReviewPort | undefined;
  #started = false;
  #controlStarted = false;
  #closed = false;
  #startupRecoveryComplete = false;
  #startupRecovery: Promise<void> | undefined;
  #postInstallTransitionPending = false;
  #observedIssuerDeviceId: string;

  constructor(private readonly options: MeshRuntimeAssemblyOptions) {
    this.connections = new MeshConnectionRegistry({
      ...(options.connectionProjection ? { projection: options.connectionProjection } : {}),
      onProjectionError: (error) => options.onError?.(error),
    });
    this.#observedIssuerDeviceId = options.trust.issuer.deviceId;
    this.#plannedAnchorIssuerKey = options.plannedAnchorIssuerKey;
    this.#plannedAnchorPostInstall = options.plannedAnchorPostInstall;
    const roles = new Set(options.configuration.enabledRoles);
    if (roles.has("anchor") && !options.protocol) {
      throw new Error("Anchor mesh role requires the conversation owner protocol");
    }
    if (roles.has("anchor") && !options.executorTopology) {
      throw new Error("Anchor mesh role requires the conversation executor topology adapter");
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
            if (this.#localDeviceRemovalOperation) {
              throw new Error("This device is being removed and no longer accepts new work");
            }
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
      ? new FirstPartyConversationMeshTarget({
          isReady: () => this.plannedCurrentOwnerReady(),
        })
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
                deviceId === this.#currentAnchorDeviceId() &&
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
      const anchorId = () => this.#currentAnchorDeviceId();
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
        submissionFor: () => this.#composition.submissionPort(anchorId()),
        globalQueryFor: (capability, anchorEpoch) =>
          roles.has("anchor")
            ? createAssignmentGlobalQueryPort({
                state: anchorGlobalState!,
                capability,
                anchorEpoch,
              })
            : this.#composition.globalQueryPort(anchorId(), capability, anchorEpoch),
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
        dataPlane.registerMeshServices({
          services: this.services,
          operations,
          surfacePrincipalFor,
          authorizeOwner: (connection) =>
            connection.peer.deviceId === this.#currentAnchorDeviceId() &&
            this.#peerHasRole(connection.peer.deviceId, "anchor"),
          ownerMayPresentSurfaceTicket: (connection) =>
            connection.peer.deviceId === this.#currentAnchorDeviceId() &&
            this.#peerHasRole(connection.peer.deviceId, "anchor"),
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
              deviceId === this.#currentAnchorDeviceId() &&
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
              deviceId === this.#currentAnchorDeviceId() &&
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
              connection.peer.deviceId === this.#currentAnchorDeviceId() &&
              this.#peerHasRole(connection.peer.deviceId, "anchor"),
            authorizePeer: (deviceId) => this.#peerHasRole(deviceId, "anchor"),
          }),
        );
      }
    }

    if (roles.has("anchor")) {
      this.#disposers.push(
        registerSurfaceAssetMeshService(this.services, {
          coordinator: () => options.authority.surfaceAssets,
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
        (deviceId) =>
          this.#peerHasRole(deviceId, "executor") ||
          this.#peerHasRole(deviceId, "anchor"),
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
          rootLifecycle: true,
          commitRootActivation: ({ plan, record }) =>
            commitRecoveryRootLifecycleActivation(options.bootstrapStore, plan, record),
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

    this.#disposers.push(registerPlannedAnchorTrustReconciliationService(
      this.services,
      {
        store: options.bootstrapStore,
        authorizePeer: (deviceId) => this.#control.currentTrust().members.some((member) =>
          member.device.deviceId === deviceId && member.state === "active"),
      },
    ));
    this.#disposers.push(registerDisasterRecoveryTrustEvidenceService(
      this.services,
      {
        store: options.bootstrapStore,
        authorizePeer: (deviceId) => this.#control.currentTrust().members.some((member) =>
          member.device.deviceId === deviceId && member.state === "active"),
      },
    ));

    this.#control = new ProductionMeshControlPlane({
      localIdentity: options.authority.identityKey,
      trust: options.trust,
      configuration: options.configuration,
      endpoints: options.endpoints,
      transportPeers: options.transportPeers,
      secretStore: options.secretStore,
      bootstrapStore: options.bootstrapStore,
      services: this.services,
      terminalOnly: {
        services: this.#terminalOnlyServices,
        authorizePeer: (deviceId) =>
          this.#deviceRemovalAuthority?.authorizesTarget(deviceId) === true,
      },
      connections: this.connections,
      credentialRouteGuard: new CredentialExposureAuthority({
        deviceId: options.authority.deviceId,
        log: options.bootstrapStore.authorityLog(),
        secretStore: options.secretStore,
      }),
      ...(options.localEndpoint ? { localEndpoint: options.localEndpoint } : {}),
      onTrustReconciled: async (record) => {
        for (const deviceId of this.#deviceRemovalGuards.keys()) {
          if (!record.members.some((member) =>
            member.device.deviceId === deviceId && member.state === "active") &&
            this.#deviceRemovalAuthority?.authorizesTarget(deviceId) !== true) {
            this.#deviceRemovalGuards.delete(deviceId);
          }
        }
        await options.onTrustApplied?.(record);
        const becameCurrentIssuer =
          this.#observedIssuerDeviceId !== options.authority.deviceId &&
          record.issuer.deviceId === options.authority.deviceId;
        this.#observedIssuerDeviceId = record.issuer.deviceId;
        if (record.issuer.deviceId !== options.authority.deviceId) {
          this.#installDeviceRemovalIssuer(record, undefined);
        }
        if (becameCurrentIssuer && this.#plannedAnchorPostInstall === undefined) {
          this.#postInstallTransitionPending = true;
        }
        options.authority.reconcileTrustedDevices(
          record.members.map((member) => member.device),
          record.members
            .filter((member) => member.state === "active")
            .map((member) => member.device.deviceId),
        );
        if (roles.has("anchor")) {
          await this.#replacePlannedAnchorRole(record);
          if (this.#postInstallTransitionPending) {
            await this.#loadLiveDisasterPostInstall(record);
          }
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
            if (this.#control.currentTrust().members.some((member) =>
              member.device.deviceId === connection.peer.deviceId &&
              member.state === "active")) {
              const reconciled = await reconcilePlannedAnchorTrustFromPeer(
                this.connections.client(connection.peer.deviceId),
                {
                  store: options.bootstrapStore,
                  localDeviceId: options.authority.deviceId,
                },
              );
              await this.#control.reconcileTrust(reconciled);
            }
            const pendingRemovalAbort = await this.#deviceRemovalAuthority?.pendingAbortForTarget(
              connection.peer.deviceId,
            );
            if (pendingRemovalAbort) {
              await new DeviceRemovalTargetMeshClient(
                this.connections.client(connection.peer.deviceId),
              ).abort(pendingRemovalAbort.operationId, pendingRemovalAbort.abort);
            }
            if (connection.peer.deviceId === this.#currentAnchorDeviceId()) {
              await this.#deviceRemovalTarget.resumeWithIssuer(
                new DeviceRemovalIssuerMeshClient(
                  this.connections.client(connection.peer.deviceId),
                  options.authority.verifier,
                ),
              );
            }
            await this.#plannedTransferRuntime.run(async () => {
              await this.#plannedAnchorOwner?.recoverBeforeAdmission();
            });
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

    this.#deviceRemovalTarget = new ExecutorRemovalTarget({
      log: options.bootstrapStore.authorityLog(),
      homeId: options.trust.homeId,
      deviceKey: options.authority.identityKey,
      verifier: options.authority.verifier,
      ...(options.localConversationOwner
        ? { localOwner: options.localConversationOwner }
        : {}),
      captureExternalAcceptedWork: (operationId) => this.#deviceRemovalCaptureAcceptedWork
        ? this.#deviceRemovalCaptureAcceptedWork(operationId)
        : Promise.reject(new Error("Device removal accepted-work capture is not bound")),
      closeAdmission: async (operationId) => {
        if (
          this.#localDeviceRemovalOperation &&
          this.#localDeviceRemovalOperation !== operationId
        ) {
          throw new Error("Another device removal already owns local admission");
        }
        if (!this.#deviceRemovalCloseAdmission) {
          throw new Error("Device removal admission lifecycle is not bound");
        }
        this.#localDeviceRemovalOperation = operationId;
        await this.#deviceRemovalCloseAdmission(operationId);
      },
      settleAcceptedWork: (input) => this.#deviceRemovalSettleAcceptedWork
        ? this.#deviceRemovalSettleAcceptedWork(input)
        : Promise.reject(new Error("Device removal accepted-work lifecycle is not bound")),
      releaseAdmission: async (operationId) => {
        if (!this.#deviceRemovalReleaseAdmission) {
          throw new Error("Device removal admission lifecycle is not bound");
        }
        await this.#deviceRemovalReleaseAdmission(operationId);
        if (this.#localDeviceRemovalOperation === operationId) {
          this.#localDeviceRemovalOperation = undefined;
        }
      },
      transferToAnchor: (operationId, currentAnchorDeviceId, conversationIds) =>
        this.adoptLocalConversationsForRemoval({
          operationId,
          targetDeviceId: currentAnchorDeviceId,
          conversationIds,
        }),
      cleanup: (operationId) => this.#deviceRemovalCleanup
        ? this.#deviceRemovalCleanup(operationId)
        : Promise.reject(new Error("Device removal cleanup is not bound")),
      finalizeDeviceKey: (operationId, identity) => this.#deviceRemovalFinalizeKey
        ? this.#deviceRemovalFinalizeKey(operationId, identity)
        : Promise.reject(new Error("Device removal key finalizer is not bound")),
      onRemoved: (operationId) => this.#deviceRemovalRemoved?.(operationId),
    });
    this.#disposers.push(registerDeviceRemovalTargetMeshService(
      this.services,
      {
        target: this.#deviceRemovalTarget,
        issuerFor: (deviceId) => new DeviceRemovalIssuerMeshClient(
          this.connections.client(deviceId),
          options.authority.verifier,
        ),
        authorizeIssuer: (deviceId) =>
          deviceId === this.#control.currentTrust().issuer.deviceId,
      },
    ));
    const issuerKey = options.trust.issuer.deviceId === options.authority.deviceId
      ? options.plannedAnchorIssuerKey ?? options.authority.identityKey
      : undefined;
    this.#installDeviceRemovalIssuer(options.trust, issuerKey);
    this.#disposers.push(() => this.#disposeDeviceRemovalIssuer?.());

    if (roles.has("anchor")) {
      this.#installInitialPlannedAnchorRole(options.trust);
      options.executorTopology!.bindDirectory(this.#remoteDirectory());
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
      this.#composition.usageIntake(this.#currentAnchorDeviceId()),
      (report) => usageReporterContext(report.reporterId, report.digest),
    );
  }

  /** Executor role 组合根用它绑定 owner submission；mesh 本身不持有 worker 生命周期。 */
  submissionForAnchor(): JobSubmissionOwner {
    return this.#composition.submissionPort(this.#currentAnchorDeviceId());
  }

  globalQueryForAnchor(
    capability: import("@zhixing/core/contracts").AuthorityCapability,
    anchorEpoch: number,
  ): import("@zhixing/core/contracts").AssignmentGlobalQueryPort {
    return this.#composition.globalQueryPort(
      this.#currentAnchorDeviceId(),
      capability,
      anchorEpoch,
    );
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

  #installDeviceRemovalIssuer(record: HomeTrustRecord, issuerKey: DeviceKey | undefined): void {
    const shouldOwn = record.issuer.deviceId === this.options.authority.deviceId;
    const expectedPublicKey = record.issuer.issuerPublicKey ?? record.members.find((member) =>
      member.device.deviceId === record.issuer.deviceId)?.device.publicKey;
    const keyMatches = issuerKey !== undefined &&
      issuerKey.deviceId === record.issuer.issuerKeyId &&
      issuerKey.publicKey === expectedPublicKey;
    if (!shouldOwn || !keyMatches) {
      this.#disposeDeviceRemovalIssuer?.();
      this.#disposeDeviceRemovalIssuer = undefined;
      this.#deviceRemovalAuthority = undefined;
      this.#deviceRemovalIssuerKeyId = undefined;
      return;
    }
    if (this.#deviceRemovalAuthority && this.#deviceRemovalIssuerKeyId === issuerKey.deviceId) {
      return;
    }
    this.#disposeDeviceRemovalIssuer?.();
    const authority = new CurrentIssuerDeviceRemovalAuthority({
      store: this.options.bootstrapStore,
      issuerKey,
      secretStore: this.options.secretStore,
      verifier: this.options.authority.verifier,
      isReachable: (deviceId) => this.connections.has(deviceId),
      onGuardChanged: (deviceId, operationId) =>
        this.setDeviceRemovalGuard(deviceId, operationId),
      onTrustCommitted: (next) => this.applyDeviceRemovalTrust(next),
    });
    this.#deviceRemovalAuthority = authority;
    this.#deviceRemovalIssuerKeyId = issuerKey.deviceId;
    const disposeActive = registerDeviceRemovalIssuerMeshService(
      this.services,
      {
        authority,
        authorizeTarget: (deviceId) =>
          authority.authorizesTarget(deviceId) ||
          this.#control.currentTrust().members.some((member) =>
            member.state === "active" && member.device.deviceId === deviceId),
      },
    );
    const disposeTerminal = registerDeviceRemovalIssuerMeshService(
      this.#terminalOnlyServices,
      {
        authority,
        authorizeTarget: (deviceId) => authority.authorizesTarget(deviceId),
        terminalOnly: true,
      },
    );
    this.#disposeDeviceRemovalIssuer = () => {
      disposeTerminal();
      disposeActive();
    };
  }

  async bindDeviceRemovalLifecycle(input: {
    readonly closeAdmission: (operationId: string) => Promise<void>;
    readonly captureAcceptedWork: (
      operationId: string,
    ) => Promise<LocalConversationRemovalSnapshot["ownerItems"]>;
    readonly settleAcceptedWork: (input: {
      readonly operationId: string;
      readonly mode: "transfer" | "destroy";
      readonly ownerItems: LocalConversationRemovalSnapshot["ownerItems"];
    }) => Promise<void>;
    readonly releaseAdmission: (operationId: string) => Promise<void>;
    readonly cleanup: (
      operationId: string,
    ) => Promise<readonly import("@zhixing/core/protocol").DeviceLifecycleEvidenceRef[]>;
    readonly finalizeDeviceKey: (
      operationId: string,
      identity: import("@zhixing/core/protocol").ExecutorRemovalLifecycleIdentity,
    ) => Promise<readonly import("@zhixing/core/protocol").DeviceLifecycleEvidenceRef[]>;
    readonly onRemoved: (operationId: string) => void | Promise<void>;
  }): Promise<void> {
    if (
      this.#deviceRemovalCleanup ||
      this.#deviceRemovalRemoved ||
      this.#deviceRemovalCloseAdmission ||
      this.#deviceRemovalCaptureAcceptedWork ||
      this.#deviceRemovalSettleAcceptedWork ||
      this.#deviceRemovalReleaseAdmission ||
      this.#deviceRemovalFinalizeKey
    ) {
      throw new Error("Device removal lifecycle is already bound");
    }
    this.#deviceRemovalCloseAdmission = input.closeAdmission;
    this.#deviceRemovalCaptureAcceptedWork = input.captureAcceptedWork;
    this.#deviceRemovalSettleAcceptedWork = input.settleAcceptedWork;
    this.#deviceRemovalReleaseAdmission = input.releaseAdmission;
    this.#deviceRemovalCleanup = input.cleanup;
    this.#deviceRemovalFinalizeKey = input.finalizeDeviceKey;
    this.#deviceRemovalRemoved = input.onRemoved;
    await this.#deviceRemovalTarget.resumeBeforeAdmission();
  }

  async removableDevices() {
    if (!this.#deviceRemovalAuthority) {
      throw new Error("Only the current duty device can list removable devices");
    }
    return this.#deviceRemovalAuthority.candidates();
  }

  deviceRemovalCommandContext() {
    const trust = this.#control.currentTrust();
    return Object.freeze({
      localDeviceId: this.options.authority.deviceId,
      currentDutyDeviceId: trust.issuer.deviceId,
      members: Object.freeze(trust.members.map((member) => Object.freeze({
        deviceId: member.device.deviceId,
        displayName: member.device.displayName,
        state: member.state,
      }))),
    });
  }

  async acceptDeviceRemovalForTarget(input: {
    readonly requestId: string;
    readonly operationId: string;
    readonly targetDeviceId: string;
  }): Promise<ExecutorRemovalReceipt> {
    if (!this.#deviceRemovalAuthority) {
      throw new Error("Only the current duty device can remove a paired device");
    }
    return this.#deviceRemovalAuthority.acceptForDevice(input);
  }

  async deviceRemovalOperation(
    operationId: string,
  ): Promise<ExecutorRemovalLifecycleIdentity | undefined> {
    if (!this.#deviceRemovalAuthority) {
      throw new Error("Only the current duty device can continue device removal");
    }
    return this.#deviceRemovalAuthority.operation(operationId);
  }

  async deviceRemovalOperationForTarget(
    targetDeviceId: string,
  ): Promise<ExecutorRemovalLifecycleIdentity | undefined> {
    if (!this.#deviceRemovalAuthority) {
      throw new Error("Only the current duty device can continue device removal");
    }
    return this.#deviceRemovalAuthority.operationForTarget(targetDeviceId);
  }

  async abortDeviceRemoval(operationId: string): Promise<DeviceLifecycleAbort> {
    if (!this.#deviceRemovalAuthority) {
      throw new Error("Only the current duty device can continue device removal");
    }
    return this.#deviceRemovalAuthority.abort(operationId);
  }

  async commitLostDeviceRemoval(operationId: string): Promise<void> {
    if (!this.#deviceRemovalAuthority) {
      throw new Error("Only the current duty device can continue device removal");
    }
    await this.#deviceRemovalAuthority.commitLost(operationId);
  }

  isDeviceRemovalTargetConnected(targetDeviceId: string): boolean {
    return this.connections.has(targetDeviceId);
  }

  acceptDeviceRemovalOnTarget(input: {
    readonly targetDeviceId: string;
    readonly accepted: ExecutorRemovalReceipt;
  }): Promise<{
    readonly conversations: readonly string[];
    readonly hasAcceptedWork: boolean;
  }> {
    return new DeviceRemovalTargetMeshClient(
      this.connections.client(input.targetDeviceId),
    ).accept(input.accepted);
  }

  abortDeviceRemovalOnTarget(input: {
    readonly targetDeviceId: string;
    readonly operationId: string;
    readonly abort: DeviceLifecycleAbort;
  }): Promise<ExecutorRemovalPublicState> {
    return new DeviceRemovalTargetMeshClient(
      this.connections.client(input.targetDeviceId),
    ).abort(input.operationId, input.abort);
  }

  decideDeviceRemovalOnTarget(input: {
    readonly targetDeviceId: string;
    readonly operationId: string;
    readonly mode: "transfer" | "destroy";
    readonly currentDutyDeviceId: string;
  }): Promise<ExecutorRemovalPublicState> {
    return new DeviceRemovalTargetMeshClient(
      this.connections.client(input.targetDeviceId),
    ).decide({
      operationId: input.operationId,
      mode: input.mode,
      currentAnchorDeviceId: input.currentDutyDeviceId,
    });
  }

  async deviceRemovalStatus(input: {
    readonly targetName: string;
  }) {
    const trust = this.#control.currentTrust();
    const named = trust.members.filter((candidate) =>
      candidate.device.displayName === input.targetName);
    if (named.length !== 1) {
      throw new Error(named.length === 0
        ? "Paired device name is unknown"
        : "Paired device name is not unique");
    }
    const member = named[0]!;
    const operation = await this.#deviceRemovalAuthority?.operationForTarget(
      member.device.deviceId,
    );
    if (!operation) return undefined;
    return resolveDeviceRemovalStatus({
      targetStatus: this.connections.has(member.device.deviceId)
        ? () => new DeviceRemovalTargetMeshClient(
            this.connections.client(member.device.deviceId),
          ).status(operation.operationId)
        : undefined,
      issuerStatus: () => this.#deviceRemovalAuthority!.publicStateForTarget(
        member.device.deviceId,
      ),
    });
  }

  async retireLocalDeviceAfterMigration(input: {
    readonly operationId: string;
  }): Promise<void> {
    const issuerDeviceId = this.#currentAnchorDeviceId();
    if (issuerDeviceId === this.options.authority.deviceId) {
      throw new Error("Anchor migration has not installed a new current duty device");
    }
    if (!this.connections.has(issuerDeviceId)) {
      throw new Error("The new duty device is offline; uninstall must resume when it reconnects");
    }
    const client = new DeviceRemovalIssuerMeshClient(
      this.connections.client(issuerDeviceId),
      this.options.authority.verifier,
    );
    const removalOperationId = `${input.operationId}:remove-old-anchor`;
    const accepted = await client.acceptSelf({
      requestId: `${input.operationId}:retire-request`,
      operationId: removalOperationId,
    });
    await this.#deviceRemovalTarget.accept(accepted);
    const decision = await this.#deviceRemovalTarget.decide({
      operationId: removalOperationId,
      mode: "transfer",
      currentAnchorDeviceId: issuerDeviceId,
    });
    if (decision.kind === "preflight-changed") {
      throw new Error("Accepted work changed; review and retry local retirement");
    }
    const cleanupReady = await this.#deviceRemovalTarget.finish(
      await client.ready(decision.receipt),
    );
    if (!cleanupReady) throw new Error("Retiring device did not produce cleanup-ready");
    await this.#deviceRemovalTarget.finish(await client.cleanupReady(cleanupReady));
  }

  async plannedAnchorTargets(): Promise<readonly {
    readonly deviceId: string;
    readonly displayName: string;
    readonly ready: boolean;
    readonly code?: "unavailable";
  }[]> {
    this.#requirePlannedCurrentOwnerReady();
    this.#requireNoDeviceRemoval();
    if (!this.#plannedAnchorOwner) return [];
    return this.#plannedTransferRuntime.run(async () => {
      const sourceDeviceId = this.#currentAnchorDeviceId();
      const candidates = this.#control.currentTrust().members
        .filter((member) =>
          member.state === "active" &&
          member.device.deviceId !== this.options.authority.deviceId &&
          member.roles.includes("anchor"))
        .sort((left, right) =>
          left.device.displayName.localeCompare(right.device.displayName, "zh-CN"));
      return Promise.all(candidates.map(async (member) => {
        try {
          await new PlannedAnchorTransferMeshClient(
            this.connections.client(member.device.deviceId),
            sourceDeviceId,
            member.device.deviceId,
            this.options.authority.verifier,
          ).summary();
          return Object.freeze({
            deviceId: member.device.deviceId,
            displayName: member.device.displayName,
            ready: true,
          });
        } catch {
          return Object.freeze({
            deviceId: member.device.deviceId,
            displayName: member.device.displayName,
            ready: false,
            code: "unavailable" as const,
          });
        }
      }));
    });
  }

  dutyMigrationCommandContext() {
    const trust = this.#control.currentTrust();
    return Object.freeze({
      localDeviceId: this.options.authority.deviceId,
      currentDutyDeviceId: this.#currentAnchorDeviceId(),
      currentOwnerReady: this.plannedCurrentOwnerReady(),
      deviceRemovalInProgress: this.#deviceRemovalGuards.size > 0,
      members: Object.freeze(trust.members.map((member) => Object.freeze({
        deviceId: member.device.deviceId,
        state: member.state,
        dutyCapable: member.roles.includes("anchor"),
      }))),
    });
  }

  preparePlannedAnchorTransfer(input: {
    readonly requestId: string;
    readonly transferId: string;
    readonly targetDeviceId: string;
  }) {
    this.#requirePlannedCurrentOwnerReady();
    this.#requireNoDeviceRemoval();
    const owner = this.#plannedAnchorOwner;
    if (!owner) throw new Error("This device is not the current duty device");
    return this.#plannedTransferRuntime.run(() => owner.prepare(input));
  }

  fencePlannedAnchorTransfer(input: {
    readonly requestId: string;
    readonly transferId: string;
  }) {
    this.#requirePlannedCurrentOwnerReady();
    this.#requireNoDeviceRemoval();
    const owner = this.#plannedAnchorOwner;
    if (!owner) throw new Error("This device is not the current duty device");
    return this.#plannedTransferRuntime.run(() => owner.fence(input));
  }

  async commitPlannedAnchorTransfer(input: {
    readonly requestId: string;
    readonly transferId: string;
  }) {
    this.#requirePlannedCurrentOwnerReady();
    this.#requireNoDeviceRemoval();
    const owner = this.#plannedAnchorOwner;
    if (!owner) throw new Error("This device is not the current duty device");
    return this.#plannedTransferRuntime.run(async () => {
      await owner.freeze(input);
      return owner.commit(input);
    });
  }

  abortPlannedAnchorTransfer(input: {
    readonly requestId: string;
    readonly transferId: string;
  }) {
    this.#requirePlannedCurrentOwnerReady();
    const owner = this.#plannedAnchorOwner;
    if (!owner) throw new Error("This device is not the current duty device");
    return this.#plannedTransferRuntime.run(() =>
      owner.abort({ ...input, reason: "operator-cancelled" }));
  }

  setDeviceRemovalGuard(targetDeviceId: string, operationId: string | undefined): void {
    const current = this.#deviceRemovalGuards.get(targetDeviceId);
    if (operationId === undefined) {
      this.#deviceRemovalGuards.delete(targetDeviceId);
      return;
    }
    if (current && current !== operationId) {
      throw new Error("A different removal operation already owns this device");
    }
    if (targetDeviceId === this.#currentAnchorDeviceId()) {
      throw new Error("The current duty device cannot enter executor removal");
    }
    this.#deviceRemovalGuards.set(targetDeviceId, operationId);
  }

  async applyDeviceRemovalTrust(record: HomeTrustRecord): Promise<void> {
    await this.#control.reconcileTrust(record);
    const revoked = record.members
      .filter((member) => member.state !== "active")
      .map((member) => member.device.deviceId);
    for (const deviceId of revoked) {
      await this.connections.disconnect(
        deviceId,
        new Error("Paired device access was revoked"),
      );
    }
  }

  async adoptLocalConversationsForRemoval(input: {
    readonly operationId: string;
    readonly targetDeviceId: string;
    readonly conversationIds: readonly string[];
  }): Promise<void> {
    const owner = this.options.localConversationOwner;
    if (!owner) {
      if (input.conversationIds.length === 0) return;
      throw new Error("Device removal has no local conversation owner");
    }
    const frozen = [...owner.deviceRemovalCandidates(input.operationId)].sort();
    if (canonicalize(frozen) !== canonicalize([...input.conversationIds].sort())) {
      throw new Error("Device removal transfer does not match its frozen conversation set");
    }
    if (input.targetDeviceId !== this.#currentAnchorDeviceId()) {
      throw new Error("Device removal transfer target is no longer the current duty device");
    }
    if (!this.connections.has(input.targetDeviceId)) {
      throw new Error("Current duty device is unavailable for conversation transfer");
    }
    await this.#adoptLocalConversations(input.targetDeviceId, input.conversationIds);
    const states = await listConversationTransferStates(
      this.options.authority.executorLog,
      this.options.authority.verifier,
    );
    for (const conversationId of input.conversationIds) {
      if (!states.some((state) =>
        state.identity.conversationId === conversationId &&
        state.identity.targetDeviceId === input.targetDeviceId &&
        (state.phase === "committed" || state.phase === "tombstoned"))) {
        throw new Error("Device removal conversation transfer is not durably complete");
      }
    }
  }

  async bindPlannedAnchorPostInstallConsumers(
    consumers: PlannedAnchorPostInstallConsumers,
  ): Promise<void> {
    if (this.#plannedAnchorPostInstallConsumers) {
      throw new Error("Planned anchor post-install consumers are already bound");
    }
    this.#plannedAnchorPostInstallConsumers = consumers;
    await this.#completePlannedAnchorPostInstall();
  }

  bindAuthorityCheckpointOwner(owner: AuthorityCheckpointOwnerPort | undefined): void {
    this.#plannedAnchorCheckpointOwner = owner;
  }

  bindPlannedAnchorLifecycle(lifecycle: PlannedAnchorTransferLifecycle): void {
    this.#plannedAnchorLifecycle = lifecycle;
  }

  async start(options: {
    readonly lifecycleAdmissionClosed?: boolean;
    readonly recoverAcceptedWork?: boolean;
  } = {}): Promise<void> {
    if (this.#closed) throw new Error("Mesh runtime assembly is closed");
    if (this.#started) return;
    try {
      if (options.recoverAcceptedWork !== false) {
        await this.#recoverStartupState(options.lifecycleAdmissionClosed === true);
      }
      if (options.lifecycleAdmissionClosed) this.#worker?.stopAccepting();
      this.#started = true;
      if (this.#startupRecoveryComplete && !this.#plannedAnchorPostInstall) {
        await this.#startControl();
      }
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
    await this.#plannedTransferRuntime.close();
    this.#worker?.stopAccepting();
    if (this.#controlStarted) await this.#control.stop();
    this.#controlStarted = false;
    await this.#worker?.close();
    this.#disposePlannedAnchorTarget?.();
    this.#disposePlannedAnchorSource?.();
    await this.#plannedAnchorTarget?.close();
    this.#disposePlannedAnchorTarget = undefined;
    this.#disposePlannedAnchorSource = undefined;
    this.#plannedAnchorOwner = undefined;
    this.#plannedAnchorTarget = undefined;
    this.#firstPartyConversationTarget?.close();
    this.#composition.close();
    for (const dispose of this.#disposers.splice(0).reverse()) dispose();
  }

  remoteDataPlaneTarget(executorId: string): AssignmentDataPlaneTarget {
    const deviceId = this.#activeExecutorDeviceId(executorId);
    const client = this.connections.client(deviceId);
    const stream = new AssignmentStreamMeshClient(client);
    const tickets = new DataPlaneTicketMeshClient(client);
    const target: AssignmentDataPlaneTarget = {
      acceptTicket: (ticket) => tickets.accept(ticket),
      answerChannel: (input) => tickets.answerChannel({
        assignmentId: input.assignmentId,
        requestId: input.requestId,
        ticketId: input.ticketId,
        surfacePrincipal: input.surfacePrincipal,
        decision: input.decision,
      }),
      resolveNoInteractiveSurface: (input) =>
        tickets.resolveNoInteractiveSurface(input),
      ownerStream: () => stream,
      directSurfaceStream: () => undefined,
    };
    return Object.freeze(target);
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
    readonly synchronizePermission: ConversationExecutorTopologyTarget["synchronizePermission"];
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

  /** Remote-only evidence mechanism; Host owns local/Mesh selection. */
  remoteEvidenceClient(executorId: string): EvidenceHandlerPort | undefined {
    try {
      const deviceId = this.#activeExecutorDeviceId(executorId);
      return new EvidenceMeshClient(
        this.connections.client(deviceId),
        this.options.authority.verifier,
      );
    } catch {
      return undefined;
    }
  }

  #remoteDirectory(): ConversationExecutorTopologyDirectory {
    const targets = new Map<string, ConversationExecutorTopologyTarget>();
    const targetFor = (deviceId: string): ConversationExecutorTopologyTarget => {
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
      } satisfies ConversationExecutorTopologyTarget;
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
        grant.sourceDeviceId !== this.#currentAnchorDeviceId() ||
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
      grant.targetDeviceId !== this.#currentAnchorDeviceId() ||
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

  async recoverAcceptedWorkForLifecycle(): Promise<void> {
    await this.#recoverStartupState(true);
    if (!this.#plannedAnchorPostInstall) await this.#startControl();
  }

  resumeAcceptingAfterLifecycle(): void {
    this.#worker?.resumeAccepting();
  }

  #plannedAnchorRoleFor(trust: HomeTrustRecord): string {
    const roleEnabled = this.options.configuration.enabledRoles.includes("anchor");
    const local = trust.members.find((member) =>
      member.device.deviceId === this.options.authority.deviceId);
    return roleEnabled && local?.state === "active" && local.roles.includes("anchor")
      ? trust.issuer.deviceId === this.options.authority.deviceId
        ? `owner:${trust.trustEpoch}:${trust.issuer.issuerKeyId}`
        : `target:${trust.trustEpoch}:${trust.issuer.deviceId}`
      : "disabled";
  }

  #installInitialPlannedAnchorRole(trust: HomeTrustRecord): void {
    const role = this.#plannedAnchorRoleFor(trust);
    if (role === this.#plannedAnchorRole) return;
    if (
      this.#plannedAnchorRole !== "" ||
      this.#plannedAnchorOwner ||
      this.#plannedAnchorTarget
    ) {
      throw new Error("Initial duty-role installation cannot replace a live role");
    }
    this.#plannedAnchorRole = role;
    this.#activatePlannedAnchorRole(role);
  }

  async #replacePlannedAnchorRole(trust: HomeTrustRecord): Promise<void> {
    const role = this.#plannedAnchorRoleFor(trust);
    if (role === this.#plannedAnchorRole) return;
    this.#disposePlannedAnchorTarget?.();
    this.#disposePlannedAnchorSource?.();
    const target = this.#plannedAnchorTarget;
    this.#disposePlannedAnchorTarget = undefined;
    this.#disposePlannedAnchorSource = undefined;
    this.#plannedAnchorOwner = undefined;
    this.#plannedAnchorTarget = undefined;
    this.#plannedAnchorRole = "";
    await target?.close();
    this.#plannedAnchorRole = role;
    this.#activatePlannedAnchorRole(role);
  }

  #activatePlannedAnchorRole(role: string): void {
    if (role.startsWith("owner:")) {
      this.#plannedAnchorOwner = new PlannedAnchorTransferOwner({
        deviceId: this.options.authority.deviceId,
        anchorEpoch: () => this.options.authority.anchorEpoch,
        identityKey: this.#plannedAnchorIssuerKey ?? this.options.authority.identityKey,
        bootstrapStore: this.options.bootstrapStore,
        log: this.options.authority.authorityLog,
        signer: this.#plannedAnchorIssuerKey ?? this.options.authority.signer,
        verifier: this.options.authority.verifier,
        targetFor: (deviceId) => {
          const member = this.#control.currentTrust().members.find((candidate) =>
            candidate.device.deviceId === deviceId);
          if (
            !member ||
            member.state !== "active" ||
            !member.roles.includes("anchor") ||
            deviceId === this.options.authority.deviceId
          ) {
            throw new TypeError("Migration target is not an active paired duty-capable device");
          }
          return new PlannedAnchorTransferMeshClient(
            this.connections.client(deviceId),
            this.options.authority.deviceId,
            deviceId,
            this.options.authority.verifier,
          );
        },
        artifacts: this.options.authority.artifacts,
        retention: {
          checkpointRetentionSnapshot: () =>
            this.options.authority.checkpointRetention.checkpointRetentionSnapshot(),
          retainedAtCheckpoint: (snapshot, candidates) =>
            this.options.authority.checkpointRetention.retainedAtCheckpoint(
              snapshot,
              candidates,
            ),
        },
        storageMaintenance: this.options.authority.storageMaintenance,
        ensureRecoveryCheckpoint: (transferId) =>
          this.#ensureRecoveryCheckpoint(transferId),
        lifecycle: {
          stopAccepting: () => this.#requirePlannedAnchorLifecycle().stopAccepting(),
          drainAccepted: () => this.#requirePlannedAnchorLifecycle().drainAccepted(),
          resumeAfterAbort: () => this.#requirePlannedAnchorLifecycle().resumeAfterAbort(),
        },
        onSourceCommitted: (targetDeviceId) => {
          this.#plannedCommittedTargetDeviceId = targetDeviceId;
        },
        onCommitted: (record) => this.#control.reconcileTrust(record),
      });
      this.#disposePlannedAnchorSource = registerPlannedAnchorTransferSourceMeshService(
        this.services,
        {
          source: () => this.#plannedAnchorOwner,
          authorizeTarget: (deviceId) => {
            const member = this.#control.currentTrust().members.find((candidate) =>
              candidate.device.deviceId === deviceId);
            return member?.state === "active" && member.roles.includes("anchor");
          },
          verifier: this.options.authority.verifier,
          lifecycle: this.#plannedTransferRuntime,
        },
      );
      return;
    }
    if (!role.startsWith("target:")) return;
    this.#plannedAnchorTarget = new PlannedAnchorTransferTarget({
      deviceId: this.options.authority.deviceId,
      identityKey: this.options.authority.identityKey,
      secretStore: this.options.secretStore,
      bootstrapStore: this.options.bootstrapStore,
      authorityLog: this.options.authority.authorityLog,
      artifacts: this.options.authority.artifacts,
      stagingRoot: path.join(
        this.options.zhixingHome,
        "distributed-runtime",
        "anchor-transfer-staging",
      ),
      sourceFor: (deviceId) => new PlannedAnchorTransferMeshClient(
        this.connections.client(deviceId),
        this.options.authority.deviceId,
        deviceId,
        this.options.authority.verifier,
      ),
      storageMaintenance: this.options.authority.storageMaintenance,
      signer: this.options.authority.signer,
      verifier: this.options.authority.verifier,
      readiness: this.options.authority.plannedAnchorReadiness,
      onInstalled: async (record) => {
        const completion = await completePlannedAnchorInstallationBeforeBootstrap({
          zhixingHome: this.options.zhixingHome,
          deviceId: this.options.authority.deviceId,
          secretStore: this.options.secretStore,
          bootstrapStore: this.options.bootstrapStore,
          verifier: this.options.authority.verifier,
          ...(this.options.authority.storageMaintenance
            ? { storageMaintenance: this.options.authority.storageMaintenance }
            : {}),
        });
        if (
          !completion ||
          completion.installation.trustRecord.issuer.deviceId !== record.issuer.deviceId
        ) {
          throw new Error("Installed duty device has no exact post-install descriptor");
        }
        this.#plannedAnchorPostInstall = completion;
        const issuerKey = await loadActiveAnchorIssuerKey(
          this.options.secretStore,
          record.issuer.issuerKeyId,
        );
        if (!issuerKey || issuerKey.publicKey !== record.issuer.issuerPublicKey) {
          throw new Error("Installed duty device is missing its active issuer key");
        }
        this.#plannedAnchorIssuerKey = issuerKey;
        this.options.bootstrapStore.bindIssuerKey(issuerKey);
        await this.#control.reconcileTrust(record);
        this.#installDeviceRemovalIssuer(record, issuerKey);
        await this.#completePlannedAnchorPostInstall();
      },
    });
    this.#disposePlannedAnchorTarget = registerPlannedAnchorTransferMeshServices(
      this.services,
      {
        target: () => this.#plannedAnchorTarget,
        targetDeviceId: this.options.authority.deviceId,
        currentSourceDeviceId: () => this.#control.currentTrust().issuer.deviceId,
        verifier: this.options.authority.verifier,
        lifecycle: this.#plannedTransferRuntime,
      },
    );
  }

  plannedCurrentOwnerReady(): boolean {
    return this.#plannedAnchorPostInstall === undefined && !this.#postInstallTransitionPending;
  }

  #requirePlannedCurrentOwnerReady(): void {
    if (!this.plannedCurrentOwnerReady()) {
      throw new Error("Current duty device is completing its durable migration consumers");
    }
  }

  async #completePlannedAnchorPostInstall(): Promise<void> {
    const completion = this.#plannedAnchorPostInstall;
    if (!completion) {
      if (this.#postInstallTransitionPending) return;
      if (this.#started) await this.#startControl();
      return;
    }
    const consumers = this.#plannedAnchorPostInstallConsumers;
    if (!consumers) return;
    const generationReceipt = await consumers.rebindAuthorityGeneration(
      completion.installedGeneration,
    );
    if (
      canonicalize(generationReceipt.generation) !==
        canonicalize(completion.installedGeneration) ||
      canonicalize(generationReceipt.participants) !==
        canonicalize(INSTALLED_AUTHORITY_GENERATION_PARTICIPANTS)
    ) {
      throw new Error("Installed migration authority generation receipt is incomplete");
    }
    const groups = partitionPlannedAnchorPostInstall(completion.pendingObligations);
    assertPlannedAnchorConsumerReceipt(
      groups.scheduler,
      await consumers.recoverScheduler(groups.scheduler),
      "scheduler",
    );
    assertPlannedAnchorConsumerReceipt(
      groups.conversation,
      await consumers.recoverConversation(groups.conversation),
      "conversation",
    );
    assertPlannedAnchorConsumerReceipt(
      groups.delivery,
      await consumers.recoverDelivery(groups.delivery),
      "delivery",
    );
    const readBack = await readBackPlannedAnchorPostInstallObligations({
      log: this.options.authority.authorityLog,
      obligations: completion.pendingObligations,
    });
    if (readBack.length !== completion.pendingObligations.length) {
      throw new Error("Installed migration obligations were not completely read back");
    }
    if (completion.installation.t === "disaster-anchor-installed") {
      if (!("mode" in completion.installedGeneration) ||
        completion.installedGeneration.mode !== "disaster-recovery") {
        throw new Error("Disaster installation generation is invalid");
      }
      await finishDisasterRecoveryPostInstall({
        zhixingHome: this.options.zhixingHome,
        transferId: completion.installation.transferId,
        readiness: this.options.authority.plannedAnchorReadiness,
        authorityLog: this.options.authority.authorityLog,
        installedGeneration: completion.installedGeneration,
        participants: generationReceipt.participants,
        readBack,
      });
    } else {
      await finishPlannedAnchorPostInstall({
        zhixingHome: this.options.zhixingHome,
        transferId: completion.installation.transferId,
        readiness: this.options.authority.plannedAnchorReadiness,
      });
    }
    this.#plannedAnchorPostInstall = undefined;
    this.#postInstallTransitionPending = false;
    await consumers.openCurrentOwnerSurfaces();
    if (this.#started) await this.#startControl();
  }

  async #loadLiveDisasterPostInstall(record: HomeTrustRecord): Promise<void> {
    const completion = await completeDisasterRecoveryInstallationBeforeBootstrap({
      zhixingHome: this.options.zhixingHome,
      deviceId: this.options.authority.deviceId,
      secretStore: this.options.secretStore,
      bootstrapStore: this.options.bootstrapStore,
      ...(this.options.authority.storageMaintenance
        ? { storageMaintenance: this.options.authority.storageMaintenance }
        : {}),
    });
    if (
      !completion ||
      completion.installation.trustRecord.issuer.deviceId !== record.issuer.deviceId ||
      canonicalize(completion.installation.trustRecord) !== canonicalize(record)
    ) {
      throw new Error("Current disaster recovery installation has no exact live descriptor");
    }
    const issuerKey = await loadActiveAnchorIssuerKey(
      this.options.secretStore,
      record.issuer.issuerKeyId,
    );
    if (!issuerKey || issuerKey.publicKey !== record.issuer.issuerPublicKey) {
      throw new Error("Current disaster recovery installation is missing its active issuer key");
    }
    this.#plannedAnchorIssuerKey = issuerKey;
    this.options.bootstrapStore.bindIssuerKey(issuerKey);
    this.#installDeviceRemovalIssuer(record, issuerKey);
    if (!completion.requiresPostInstallCompletion) {
      this.#postInstallTransitionPending = false;
      return;
    }
    this.#plannedAnchorPostInstall = completion;
    await this.#completePlannedAnchorPostInstall();
  }

  async #startControl(): Promise<void> {
    if (this.#controlStarted || this.#closed) return;
    await this.#control.start();
    this.#controlStarted = true;
  }

  async #recoverStartupState(lifecycleAdmissionClosed: boolean): Promise<void> {
    if (this.#startupRecoveryComplete) return;
    if (this.#startupRecovery) return this.#startupRecovery;
    const recovery = (async () => {
      for (const operationId of await this.#deviceRemovalTarget.restoreLocalAdmissionGate()) {
        if (
          this.#localDeviceRemovalOperation &&
          this.#localDeviceRemovalOperation !== operationId
        ) {
          throw new Error("Conflicting local device removal operations cannot share admission");
        }
        this.#localDeviceRemovalOperation = operationId;
      }
      await this.#plannedTransferRuntime.run(async () => {
        await this.#plannedAnchorTarget?.recoverBeforeAdmission();
        await this.#plannedAnchorOwner?.recoverBeforeAdmission();
      });
      await this.#deviceRemovalAuthority?.resumeActive();
      await this.#restoreCommittedTransfers();
      if (lifecycleAdmissionClosed) {
        await this.#worker?.recoverAcceptedWorkForLifecycle();
      } else {
        await this.#worker?.recover();
      }
      this.#startupRecoveryComplete = true;
    })();
    this.#startupRecovery = recovery;
    try {
      await recovery;
    } finally {
      if (this.#startupRecovery === recovery) this.#startupRecovery = undefined;
    }
  }

  currentAnchorDeviceId(): string {
    return this.#currentAnchorDeviceId();
  }

  #requirePlannedAnchorLifecycle(): PlannedAnchorTransferLifecycle {
    if (!this.#plannedAnchorLifecycle) {
      throw new Error("Duty-device migration lifecycle is not bound");
    }
    return this.#plannedAnchorLifecycle;
  }

  async #ensureRecoveryCheckpoint(transferId: string): Promise<string> {
    const owner = this.#plannedAnchorCheckpointOwner;
    if (!owner) throw new Error("Recovery backup owner is unavailable");
    const status = await owner.status();
    if (status.fullBackupReady && status.checkpointId) {
      const records = await this.options.authority.authorityLog
        .readStream<CheckpointStreamRecord>("checkpoint");
      const verified = records.toReversed().find((entry) =>
        entry.body.t === "checkpoint-verified" &&
        entry.body.checkpointId === status.checkpointId &&
        entry.body.targetId === status.targetId,
      );
      if (verified?.body.t === "checkpoint-verified") {
        return verified.body.envelopeDigest;
      }
    }
    return (await owner.force(`planned-anchor:${transferId}`)).envelope.digest;
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
    await this.#postAdoptionReview?.reviewAfterAdoption(base.manifest.conversationId);
  }

  async #adoptLocalConversations(
    peerDeviceId: string,
    exactCandidates?: readonly string[],
  ): Promise<void> {
    const owner = this.options.localConversationOwner;
    if (
      !owner ||
      peerDeviceId !== this.#currentAnchorDeviceId() ||
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
    for (const conversationId of exactCandidates ?? await owner.transferCandidates()) {
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
    if (this.#deviceRemovalGuards.has(deviceId)) return false;
    return this.#control.currentTrust().members.some((member) =>
      member.device.deviceId === deviceId &&
      member.state === "active" &&
      member.roles.includes(role));
  }

  #currentAnchorDeviceId(): string {
    return this.#plannedCommittedTargetDeviceId ??
      this.#control.currentTrust().issuer.deviceId;
  }

  #requireNoDeviceRemoval(): void {
    if (this.#deviceRemovalGuards.size > 0) {
      throw new Error("Duty-device migration is unavailable while a paired device is being removed");
    }
  }
}

export async function resolveDeviceRemovalStatus(input: {
  readonly targetStatus?: () => Promise<ExecutorRemovalPublicState | undefined>;
  readonly issuerStatus: () => Promise<ExecutorRemovalPublicState | undefined>;
}): Promise<ExecutorRemovalPublicState | undefined> {
  if (input.targetStatus) {
    try {
      const target = await input.targetStatus();
      if (target) return target;
    } catch {
      // Fall through to the durable issuer projection.
    }
  }
  return input.issuerStatus();
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
