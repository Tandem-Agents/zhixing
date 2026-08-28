import { getZhixingHome, type ToolDefinition } from "@zhixing/core";
import { DeviceLifecycleJournal, type ArtifactStore } from "@zhixing/core/authority";
import path from "node:path";
import { createMcpHub, mapServerTools, type McpHub } from "@zhixing/mcp";
import {
  createAgentRuntime,
  type AgentRuntime,
  type AgentRuntimeCapacityBinding,
} from "@zhixing/orchestrator/runtime";
import { mainProfile, powerProfile } from "@zhixing/orchestrator/profile";
import { parseConversationId } from "@zhixing/core";
import type { ProviderCredentialProjection, ZhixingConfig } from "@zhixing/providers";
import { parseServerSpecs } from "../runtime/mcp-config.js";
import { createStdoutWriter } from "../screen/index.js";
import { resolveSystemProtectedSecretPaths } from "../security/secret-boundary.js";
import {
  type AuthorityRuntimeStack,
  setupAuthorityRuntime,
} from "../setup-delivery.js";
import { ZHIXING_CLI_VERSION } from "../version.js";
import {
  ASSIGNMENT_RECORD_V2_WRITES_ENABLED,
  createConversationExecutorLedger,
} from "./conversation-executor-ledger.js";
import { localConversationOwnerRuntime } from "./conversation-owner-runtime.js";
import { DurableConversationInteractionObserver } from "./durable-conversation-interactions.js";
import { createExecutorReadinessSource } from "./executor-readiness.js";
import {
  executorIdForDevice,
  MeshRuntimeAssembly,
} from "./mesh-runtime-assembly.js";
import type { ServeOptions } from "./command.js";
import type {
  ExecutorRoleModule,
  ServeBootstrapContext,
} from "./role-topology.js";
import { ExecutorDataPlaneRuntime } from "./executor-data-plane-runtime.js";
import { createAgentJobRuntimePort } from "./agent-job-runtime.js";
import {
  ExecutorJobOwnerAssembly,
  ExecutorJobOwnerLifecycle,
} from "./executor-job-owner.js";
import type { LocalWorkspaceManagementHost } from "../runtime/local-workspace-management-host.js";
import { createExecutorLocalWorkspaceHost } from "../runtime/local-workspace-bootstrap.js";
import {
  EvidenceJournal,
  ExecutorEvidenceHandler,
} from "@zhixing/orchestrator/advancement";
import { createConversationEvidenceAuthorityVerifier } from "./conversation-evidence-authority.js";
import { LocalConversationOwnerAssembly } from "./local-conversation-owner.js";
import {
  ExecutorFirstPartyRpcRouter,
  LocalConversationRpcRouter,
} from "./local-conversation-rpc.js";
import { CurrentAnchorFirstPartyRpcRouter } from "./first-party-conversation-mesh.js";
import {
  createServerContext,
  bindServer,
  DEFAULT_SERVER_CONFIG,
  getDefaultLogPath,
  isProcessAlive,
  resolveProcessStartTime,
  runServer,
  ServerStateFile,
  type RunningServer,
  type BoundZhixingServer,
} from "@zhixing/server";
import { loadOrCreateToken } from "./token.js";
import { homeToPort } from "./host-port.js";
import { isDaemonChild, resolveHostProcessMode } from "./self-exec.js";
import { deleteDeviceKeyExact } from "@zhixing/mesh/device-key-store";
import { protocolDigest } from "@zhixing/core/protocol";
import { cleanupExecutorDeviceLocalState } from "./device-removal-cleanup.js";
import {
  captureManagedHostAdmission,
  coordinateManagedHostTrustTransition,
  loadCurrentManagedServiceState,
  verifyManagedHostAdmission,
} from "./managed-service-runtime.js";
import {
  createManagedServiceAdapter,
  managedServiceDefinitionDigest,
} from "./managed-service.js";
import {
  HostStopCoordinator,
  hostStopAlreadySettled,
  hostStopDeliveryLifecycleSources,
  loadHostStopAcceptedWork,
  type HostStopAcceptedWorkItem,
  type HostStopAcceptedWorkOwner,
  type HostStopAcceptedWorkPorts,
} from "./host-stop-lifecycle.js";
import type { StopHostGeneration } from "@zhixing/core/protocol";
import { ownsCurrentSuccessorEndpoint } from "./startup-server-owner.js";
import { createMeshCompatibilityStateProjection } from "./mesh-compatibility-state.js";
import { waitForExecutorRoleTerminal } from "./executor-role-terminal.js";
import {
  createExecutorInternalStopPort,
  type ExecutorInternalStopPort,
  type ExecutorInternalStopRequest,
  shouldExecutorIdleExit,
} from "./executor-internal-stop.js";

export async function runExecutorRole(
  options: ServeOptions,
  bootstrap: ServeBootstrapContext,
  executor?: ExecutorRoleModule,
): Promise<void> {
  if (!executor) throw new Error("Executor role module is unavailable");
  if (bootstrap.mesh.mode !== "trusted-home") {
    throw new Error("A standalone executor requires an established home trust chain");
  }
  if (
    !bootstrap.mesh.roles.includes("executor") ||
    bootstrap.mesh.roles.includes("anchor")
  ) {
    throw new Error("Executor-only host received an incompatible role projection");
  }
  const startup = bootstrap.startup;
  const zhixingHome = getZhixingHome();
  const deviceCapacity = bootstrap.deviceCapacity;
  const providerCredentials = startup.credentials.providers
    ? { providers: startup.credentials.providers }
    : {};
  const mcpHub = createMcpHub(
    parseServerSpecs(startup.config.mcp, startup.credentials.mcp),
    { networkProxy: startup.config.network?.proxy },
  );
  const writer = createStdoutWriter();
  const processStartedAt = new Date().toISOString();
  const processStartTime = await resolveProcessStartTime(process.pid);
  const lifecycleLog = bootstrap.mesh.bootstrapStore.authorityLog();
  const lifecycleHomeId = (await lifecycleLog.originCheckpoint()).logId;
  const lifecycleJournal = new DeviceLifecycleJournal(lifecycleLog);
  const startupStopOperations = (await lifecycleJournal.active()).filter((operation) =>
    operation.identity.kind === "stop" &&
    operation.identity.homeId === lifecycleHomeId &&
    operation.identity.localDeviceId === bootstrap.mesh.deviceKey.deviceId);
  if (startupStopOperations.length > 1) {
    throw new Error("More than one local lifecycle operation owns executor startup admission");
  }
  const startupStopOperation = startupStopOperations[0];
  const startupStopSnapshot = startupStopOperation?.evidence.some((item) =>
    item.kind === "accepted-work" && item.artifact)
    ? await loadHostStopAcceptedWork(
        startupStopOperation,
        bootstrap.mesh.bootstrapStore.artifactStore(),
      )
    : undefined;
  const startupStopSources = startupStopSnapshot
    ? hostStopDeliveryLifecycleSources(startupStopSnapshot)
    : [];
  // Startup stays closed until resumeActive() proves the old host terminal.
  const startupStopRecoverAcceptedWork = false;
  const startupStopAlreadySettled = startupStopOperation
    ? hostStopAlreadySettled(startupStopOperation.phase)
    : false;
  let startupStopAcceptedWorkRecovered = startupStopRecoverAcceptedWork;
  const processMode = resolveHostProcessMode(options.managed);
  const localServerPort = options.port ?? homeToPort(zhixingHome);
  const localServerHost = options.host ?? DEFAULT_SERVER_CONFIG.host;

  const initialAnchorDeviceId = bootstrap.mesh.trust.issuer.deviceId;
  let mesh: MeshRuntimeAssembly | undefined;
  const currentAnchorDeviceId = () =>
    mesh?.currentAnchorDeviceId() ?? initialAnchorDeviceId;
  let jobOwnerAssembly: ExecutorJobOwnerAssembly | undefined;
  let jobOwnerLifecycle: ExecutorJobOwnerLifecycle | undefined;
  let authority: AuthorityRuntimeStack | undefined;
  let dataPlane: ExecutorDataPlaneRuntime | undefined;
  let localWorkspaceHost: LocalWorkspaceManagementHost | undefined;
  let evidenceHandler: ExecutorEvidenceHandler | undefined;
  let localConversationOwner: LocalConversationOwnerAssembly | undefined;
  let localConversationServer: RunningServer | undefined;
  let localServerBinding: BoundZhixingServer | undefined;
  let localServerState: ServerStateFile | undefined;
  let localServerHeartbeat: NodeJS.Timeout | undefined;
  let executorIdleTimer: NodeJS.Timeout | undefined;
  let executorIdleCheck: Promise<void> | undefined;
  let resolveLifecycleShutdown: (() => void) | undefined;
  const lifecycleShutdown = new Promise<void>((resolve) => {
    resolveLifecycleShutdown = resolve;
  });
  let roleFailure: unknown;
  try {
    // Establish the same final endpoint owner before MCP, authority, workspace,
    // data-plane, job or local conversation owners can produce effects.
    localServerBinding = await bindServer({
      config: {
        ...DEFAULT_SERVER_CONFIG,
        port: localServerPort,
        host: localServerHost,
      },
    });
    const initialManagedServiceState = await loadCurrentManagedServiceState(
      "activate",
      zhixingHome,
    );
    const initialManagedHostAdmission = await captureManagedHostAdmission(
      processMode,
      zhixingHome,
      async () => initialManagedServiceState,
    );
    const managedState = processMode === "managed"
      ? initialManagedServiceState
      : undefined;
    if (processMode === "managed" && !managedState?.spec) {
      throw new Error("Managed executor stop identity requires the installed service definition");
    }
    const endpointLock = {
      pid: process.pid,
      port: localServerBinding.port,
      startTime: processStartTime,
      startedAt: processStartedAt,
    } as const;
    localServerState = new ServerStateFile({
      publishReadyMarker: processMode !== "foreground",
    });
    const meshConnectionProjection = createMeshCompatibilityStateProjection(
      localServerState,
      { ...endpointLock, host: localServerBinding.host },
    );
    await meshConnectionProjection.replaceCurrent([]);
    const stopHost: StopHostGeneration = processMode === "managed" && managedState?.spec
      ? {
          kind: "managed",
          serviceId: managedState.spec.serviceId,
          definitionDigest: managedServiceDefinitionDigest(managedState.spec),
          instanceId: `${process.pid}:${processStartedAt}`,
          endpointLock,
        }
      : {
          kind: "foreground",
          processId: process.pid,
          startedAt: processStartedAt,
          endpointLock,
        };
    await mcpHub.connectAll();
    const interactions = new DurableConversationInteractionObserver();
    const runtime = new ExecutorRuntimeSubstrate({
      config: startup.config,
      credentials: providerCredentials,
      mcpHub,
      systemProtectedPaths: resolveSystemProtectedSecretPaths(),
      interactions,
      artifactStore: () => {
        if (!authority) throw new Error("Executor artifact store is not ready");
        return authority.artifacts;
      },
      deviceCapacity: {
        interactive: deviceCapacity.workload("workload-interactive"),
        scheduler: deviceCapacity.workload("workload-scheduler"),
        orchestration: deviceCapacity.workload("workload-orchestration"),
      },
    });
    authority = await setupAuthorityRuntime({
      zhixingHome,
      secretStore: bootstrap.secretStore,
      deviceKey: bootstrap.mesh.deviceKey,
      trustedIdentities: bootstrap.mesh.trustedIdentities,
      authorizedDeviceIds: bootstrap.mesh.authorizedDeviceIds,
      executorId: executorIdForDevice(bootstrap.mesh.deviceKey.deviceId),
      configurationSnapshot: {
        config: startup.config,
        executableVersion: ZHIXING_CLI_VERSION,
      },
      executorReadiness: createExecutorReadinessSource({
        runtime,
        credentials: startup.credentials,
        credentialGeneration: startup.credentialGeneration,
      }),
      enableAnchor: false,
      enableLocalExecutor: true,
      storageMaintenance: deviceCapacity.storage,
      deviceCapacity: deviceCapacity.arbiter,
    });
    if (startupStopOperation) {
      await authority.authority.restoreLifecycleAdmission({
        operationId: startupStopOperation.identity.operationId,
        sources: startupStopSources,
        deliveries: startupStopSnapshot?.owners.delivery ?? [],
        sealed: startupStopAlreadySettled,
      });
    }
    if (!authority.workspaceBindingAdmin || !authority.workspaceBindingRecovery) {
      throw new Error("Local workspace management ports are unavailable");
    }
    localWorkspaceHost = createExecutorLocalWorkspaceHost({
      identity: bootstrap.localWorkspaceIdentity,
      host: {
        zhixingHome,
        facade: {
          deviceId: authority.deviceId,
          executorId: executorIdForDevice(authority.deviceId),
          admin: authority.workspaceBindingAdmin,
          recovery: authority.workspaceBindingRecovery,
          resources: authority.executorResourceGovernor,
        },
        storageMaintenance: deviceCapacity.storage,
      },
    });
    if (!localWorkspaceHost) throw new Error("Local workspace management host is unavailable");
    await localWorkspaceHost.start();
    if (!authority.environment) {
      throw new Error("Executor evidence requires the local environment authority");
    }
    evidenceHandler = new ExecutorEvidenceHandler({
      executorId: authority.executorId,
      environment: authority.environment,
      journal: new EvidenceJournal({
        file: path.join(
          zhixingHome,
          "distributed-runtime",
          "evidence",
          `${authority.executorId}.jsonl`,
        ),
        verifier: authority.verifier,
      }),
      signer: authority.signer,
      verifier: authority.verifier,
      verifyCurrentOwner: createConversationEvidenceAuthorityVerifier({
        authority,
        currentAnchorDeviceId,
      }),
      capacity: deviceCapacity.workload("workload-advancement"),
    });
    dataPlane = new ExecutorDataPlaneRuntime({
      zhixingHome,
      authority,
      module: executor,
      storageMaintenance: deviceCapacity.storage,
      onError: (error) => writer.notify(`[data-plane] ${error.message}`),
    });
    const localOwnerRuntime = localConversationOwnerRuntime({
      artifacts: authority.artifacts,
      deviceId: authority.deviceId,
      executorCapabilities: authority.executorCapabilities,
      executorId: authority.executorId,
      executorLog: authority.executorLog,
      executorResourceGovernor: authority.executorResourceGovernor,
      executionAssetCatalog: authority.executionAssetCatalog,
      localControlAdmission: authority.localControlAdmission,
      localDomainId: authority.localDomainId,
      localGovernorEpoch: authority.localGovernorEpoch,
      localOwnerEpoch: authority.localOwnerEpoch,
      permissionSnapshotFor: authority.permissionSnapshotFor,
      preflightLocalConversationEnvironment:
        authority.preflightLocalConversationEnvironment,
      prepareLocalConversationAssignment:
        authority.prepareLocalConversationAssignment,
      releaseLocalConversationEnvironmentPreflight:
        authority.releaseLocalConversationEnvironmentPreflight,
      signer: authority.signer,
      storageMaintenance: authority.storageMaintenance,
      validateConversationRuntimeBinding:
        authority.validateConversationRuntimeBinding,
      validateLocalConversationManifest:
        authority.validateLocalConversationManifest,
      verifier: authority.verifier,
    });
    const ledger = createConversationExecutorLedger({
      Constructor: executor.ConversationAssignmentLedger,
      authority: localOwnerRuntime,
      dataPlaneTickets: dataPlane.tickets,
      assignmentRecordV2Writes: ASSIGNMENT_RECORD_V2_WRITES_ENABLED,
      usageFinal: async (assignmentId) => {
        const domain = await authority!.executorResourceGovernor.assignmentDomain(
          assignmentId,
        );
        if (domain?.kind === "local") {
          return authority!.executorResourceGovernor.finalizeLocalAssignment(
            assignmentId,
          );
        }
        if (!mesh) throw new Error("Executor mesh runtime is not ready");
        return mesh.finalizeExecutorUsage(assignmentId);
      },
    });
    dataPlane.bindLedger(ledger);
    await dataPlane.start();
    const role = executor.createExecutorRole({
      createAgentRuntime: (sessionId, environment) =>
        runtime.createConversationRuntime(
          environment?.workspaceRoot,
          sessionId,
        ),
    });
    const runtimeFactory =
      executor.createInProcessAssignmentRuntimeFactory(role);
    localConversationOwner = await LocalConversationOwnerAssembly.create({
      owner: localOwnerRuntime,
      ledger,
      ConversationAssignmentLedger: executor.ConversationAssignmentLedger,
      InProcessAssignmentSubmission: executor.InProcessAssignmentSubmission,
      runtimeFactory,
      interactions,
      config: startup.config,
      credentials: providerCredentials,
      evidence: evidenceHandler,
      currentAnchorDeviceId,
      dataPlane,
    });
    jobOwnerAssembly = new ExecutorJobOwnerAssembly({
      ledger,
      runtime: createAgentJobRuntimePort({
        create: (instruction, confirmationBroker) =>
          runtime.createJobRuntime(instruction, confirmationBroker),
      }),
      submissionFor: () => {
        if (!mesh) throw new Error("Executor submission transport is not ready");
        return mesh.submissionForAnchor();
      },
      finalizeUsage: ({ assignmentId }) => {
        if (!mesh) throw new Error("Executor usage transport is not ready");
        return mesh.finalizeExecutorUsage(assignmentId);
      },
      globalQueryFor: (capability, anchorEpoch) => {
        if (!mesh) throw new Error("Executor global query transport is not ready");
        return mesh.globalQueryForAnchor(capability, anchorEpoch);
      },
      InProcessAssignmentSubmission: executor.InProcessAssignmentSubmission,
      resourceGovernor: authority.executorResourceGovernor,
      createStream: (input) => dataPlane!.createStream(input),
      onError: (_assignmentId, error) =>
        writer.notify(`[job-worker] ${error.message}`),
    });
    const executorInternalStop = {
      current: undefined as ExecutorInternalStopPort | undefined,
    };
    const requestExecutorInternalStop = (
      request: ExecutorInternalStopRequest,
    ): Promise<void> => {
      const stop = executorInternalStop.current;
      if (!stop) {
        return Promise.reject(new Error("Executor internal stop is not ready"));
      }
      return stop.requestStop(request);
    };
    let coordinateRuntimeTrustTransition: (() => Promise<void>) | undefined;
    const onTrustApplied = async () => {
      if (coordinateRuntimeTrustTransition) {
        await coordinateRuntimeTrustTransition();
        return;
      }
      if (!await verifyManagedHostAdmission(
        initialManagedHostAdmission,
        processMode,
        zhixingHome,
      )) {
        throw new Error("Executor Host admission changed before its stop port was ready");
      }
    };
    mesh = new MeshRuntimeAssembly({
      zhixingHome,
      trust: bootstrap.mesh.trust,
      configuration: bootstrap.mesh.configuration,
      endpoints: bootstrap.mesh.endpoints,
      transportPeers: bootstrap.mesh.transportPeers,
      bootstrapStore: bootstrap.mesh.bootstrapStore,
      ...(bootstrap.mesh.anchorIssuerKey
        ? { plannedAnchorIssuerKey: bootstrap.mesh.anchorIssuerKey }
        : {}),
      authority,
      localConversationOwner,
      executor: {
        ledger,
        runtimeFactory,
        interactions,
        dataPlane,
        InProcessAssignmentSubmission: executor.InProcessAssignmentSubmission,
        evidence: evidenceHandler,
        job: {
          owner: jobOwnerAssembly.owner,
        },
      },
      secretStore: bootstrap.secretStore,
      connectionProjection: meshConnectionProjection,
      onTrustApplied,
      onError: (error) => writer.notify(`[mesh] ${error.message}`),
    });
    let removalAdmissionOperationId: string | undefined;
    await mesh.bindDeviceRemovalLifecycle({
      closeAdmission: async (operationId) => {
        if (
          removalAdmissionOperationId !== undefined &&
          removalAdmissionOperationId !== operationId
        ) {
          throw new Error("Another device-removal operation owns executor admission");
        }
        removalAdmissionOperationId = operationId;
        jobOwnerAssembly!.pauseAccepting();
      },
      captureAcceptedWork: async () => (await jobOwnerAssembly!.acceptedWorkItems())
        .map((item) => Object.freeze({
          owner: "remote" as const,
          id: item.id,
          revision: item.revision,
        })),
      settleAcceptedWork: async ({ operationId, ownerItems }) => {
        if (removalAdmissionOperationId !== operationId) {
          throw new Error("Device-removal settlement does not own executor admission");
        }
        const frozen = ownerItems
          .filter((item) => item.owner === "remote")
          .map(({ id, revision }) => ({ id, revision }));
        assertAcceptedWorkSubset(
          await jobOwnerAssembly!.acceptedWorkItems(),
          frozen,
          "executor device-removal settlement",
        );
        await jobOwnerAssembly!.drain();
        const after = await jobOwnerAssembly!.acceptedWorkItems();
        assertAcceptedWorkSubset(after, frozen, "executor device-removal read-back");
        if (after.length > 0) {
          throw new Error("Executor job accepted work is not durably settled");
        }
        await authority!.executorResourceGovernor.coordinate(async () => undefined);
      },
      releaseAdmission: async (operationId) => {
        if (removalAdmissionOperationId === undefined) return;
        if (removalAdmissionOperationId !== operationId) {
          throw new Error("Device-removal release does not own executor admission");
        }
        jobOwnerAssembly!.resumeAccepting();
        removalAdmissionOperationId = undefined;
      },
      cleanup: async () => {
        const current = await loadCurrentManagedServiceState("activate", zhixingHome);
        const adapter = current.spec
          ? createManagedServiceAdapter({ storageGovernor: deviceCapacity.storage })
          : undefined;
        const expected = current.spec
          ? await adapter!.inspect(current.spec, new AbortController().signal)
          : undefined;
        return cleanupExecutorDeviceLocalState({
          zhixingHome,
          secretStore: bootstrap.secretStore,
          deviceKey: bootstrap.mesh.deviceKey,
          storageGovernor: deviceCapacity.storage,
          unregisterFuture: async () => {
            if (!current.spec || !adapter || !expected) return;
            await adapter.unregisterFutureExact(
              current.spec,
              expected,
              new AbortController().signal,
            );
          },
        });
      },
      finalizeDeviceKey: async (operationId, identity) => {
        if (identity.targetDeviceId !== bootstrap.mesh.deviceKey.deviceId) {
          throw new Error("Device removal key finalizer does not match this executor");
        }
        await deleteDeviceKeyExact(bootstrap.secretStore, bootstrap.mesh.deviceKey);
        return [{
          kind: "cleanup" as const,
          digest: protocolDigest("ExecutorRemovalDeviceKeyDeleted", 1, {
            operationId,
            deviceId: identity.targetDeviceId,
            generation: identity.targetDeviceKeyGeneration,
          }),
        }];
      },
      onRemoved: async () => {
        resolveLifecycleShutdown?.();
      },
    });
    jobOwnerLifecycle = new ExecutorJobOwnerLifecycle(
      jobOwnerAssembly,
      mesh,
    );
    await jobOwnerLifecycle.start(startupStopOperation
      ? {
          admissionClosed: true,
          recoverAcceptedWork: startupStopRecoverAcceptedWork,
        }
      : {});
    await localConversationOwner.start(startupStopOperation
      ? {
          lifecycle: {
            operationId: startupStopOperation.identity.operationId,
            kind: startupStopOperation.identity.kind,
            recoverAcceptedWork: startupStopRecoverAcceptedWork,
            alreadySettled: startupStopAlreadySettled,
          },
        }
      : {});
    const localOwners = new Set<HostStopAcceptedWorkOwner>([
      "conversation",
      "intent",
      "final",
      "assignment",
      "lease",
      "permit",
    ]);
    const captureHostStopWork = async (
      owner: HostStopAcceptedWorkOwner,
      operationId: string,
    ): Promise<readonly HostStopAcceptedWorkItem[]> => {
      if (localOwners.has(owner)) {
        return localConversationOwner!.hostStopAcceptedWorkItems(
          operationId,
          owner as "conversation" | "intent" | "final" | "assignment" | "lease" | "permit",
        );
      }
      if (owner === "remote") return jobOwnerAssembly!.acceptedWorkItems();
      return [];
    };
    const stopPort = (owner: HostStopAcceptedWorkOwner) => ({
      freeze: (operationId: string) => captureHostStopWork(owner, operationId),
      settle: async (input: {
        readonly operationId: string;
        readonly strategy: "immediate" | "drain" | "cancel";
        readonly timeoutMs: number;
        readonly frozen: readonly HostStopAcceptedWorkItem[];
      }) => {
        assertAcceptedWorkSubset(
          await captureHostStopWork(owner, input.operationId),
          input.frozen,
          `executor host-stop ${owner} settlement`,
        );
        if (localOwners.has(owner)) {
          await localConversationOwner!.settleHostStopAcceptedWork(
            input.operationId,
            input.strategy,
            input.timeoutMs,
          );
        } else if (owner === "remote") {
          await jobOwnerAssembly!.drain();
        }
      },
      readBack: async (input: {
        readonly operationId: string;
        readonly strategy: "immediate" | "drain" | "cancel";
        readonly frozen: readonly HostStopAcceptedWorkItem[];
      }) => {
        if (localOwners.has(owner)) {
          await localConversationOwner!.assertHostStopAcceptedWorkSettled(
            input.operationId,
            owner as "conversation" | "intent" | "final" | "assignment" | "lease" | "permit",
            input.strategy,
            input.frozen,
          );
          return;
        }
        const current = await captureHostStopWork(owner, input.operationId);
        assertAcceptedWorkSubset(current, input.frozen, `executor host-stop ${owner} read-back`);
        if (input.strategy !== "immediate" && current.length > 0) {
          throw new Error(`Executor host-stop ${owner} accepted work is not settled`);
        }
      },
    });
    const acceptedWork: HostStopAcceptedWorkPorts = {
      conversation: stopPort("conversation"),
      intent: stopPort("intent"),
      final: stopPort("final"),
      assignment: stopPort("assignment"),
      remote: stopPort("remote"),
      channel: stopPort("channel"),
      scheduler: stopPort("scheduler"),
      delivery: stopPort("delivery"),
      lease: stopPort("lease"),
      permit: stopPort("permit"),
    };
    const isLifecycleHostStopped = async (candidateHost: StopHostGeneration): Promise<boolean> => {
      const endpoint = candidateHost.endpointLock;
      if (!endpoint) return false;
      const currentReplacesEndpoint = ownsCurrentSuccessorEndpoint(
        localServerBinding!,
        endpoint,
        endpointLock,
      );
      if (
        endpoint.pid === endpointLock.pid &&
        endpoint.port === endpointLock.port &&
        endpoint.startTime === endpointLock.startTime &&
        endpoint.startedAt === endpointLock.startedAt
      ) return false;
      if (isProcessAlive(endpoint.pid) && !currentReplacesEndpoint) return false;
      if (candidateHost.kind === "foreground") return candidateHost.processId === endpoint.pid;
      try {
        const current = await loadCurrentManagedServiceState("inspect", zhixingHome);
        if (
          !current.spec ||
          current.spec.serviceId !== candidateHost.serviceId ||
          managedServiceDefinitionDigest(current.spec) !== candidateHost.definitionDigest
        ) return false;
        const inspection = await createManagedServiceAdapter({
          storageGovernor: deviceCapacity.storage,
        }).inspect(current.spec, new AbortController().signal);
        const currentSuccessor = stopHost.kind === "managed" &&
          stopHost.serviceId === candidateHost.serviceId &&
          stopHost.definitionDigest === candidateHost.definitionDigest &&
          stopHost.endpointLock?.pid === process.pid &&
          currentReplacesEndpoint &&
          isProcessAlive(process.pid);
        return inspection.matches && (!inspection.running || currentSuccessor);
      } catch {
        return false;
      }
    };
    const stopCoordinator = new HostStopCoordinator({
      journal: new DeviceLifecycleJournal(lifecycleLog),
      homeId: lifecycleHomeId,
      localDeviceId: bootstrap.mesh.deviceKey.deviceId,
      host: stopHost,
      acceptedWork,
      artifactStore: bootstrap.mesh.bootstrapStore.artifactStore(),
      onAcceptedWorkFrozen: async (snapshot) => {
        const sources = hostStopDeliveryLifecycleSources(snapshot);
        localConversationOwner!.restoreHostStopAcceptedWork(
          snapshot.operationId,
          Object.entries(snapshot.owners).flatMap(([owner, items]) =>
            items.map((item) => ({ owner: owner as HostStopAcceptedWorkOwner, ...item }))),
        );
        await authority!.authority.installLifecycleAdmission({
          operationId: snapshot.operationId,
          sources,
          deliveries: snapshot.owners.delivery,
        });
        if (!startupStopAcceptedWorkRecovered) {
          await localConversationOwner!.recoverAcceptedWorkForLifecycle();
          await jobOwnerAssembly!.recoverAcceptedWorkForLifecycle();
          await mesh!.recoverAcceptedWorkForLifecycle();
          startupStopAcceptedWorkRecovered = true;
        }
      },
      runtime: {
        closeAdmission: async (operationId) => {
          jobOwnerAssembly!.pauseAccepting();
          await localConversationOwner!.closeHostStopAdmission(operationId);
        },
        settleImmediate: () => jobOwnerAssembly!.drain(),
        drainAcceptedWork: () => jobOwnerAssembly!.drain(),
        cancelAcceptedWork: () => jobOwnerAssembly!.drain(),
        flushDurableState: async () => {
          const [checkpoint, ownerDigest] = await Promise.all([
            lifecycleLog.checkpoint(),
            localConversationOwner!.checkpointAcceptedWork(),
          ]);
          return [{
            kind: "accepted-work" as const,
            digest: protocolDigest("ExecutorHostStopDurableFlush", 1, {
              lifecycle: checkpoint.prefixDigest,
              localOwner: ownerDigest,
            }),
          }];
        },
        settlePhysicalSteps: () => authority!.executorResourceGovernor.coordinate(
          async () => undefined,
        ),
      },
      isHostStopped: isLifecycleHostStopped,
    });
    const stopResume = await stopCoordinator.resumeActive();
    if (startupStopOperation?.identity.kind === "stop") {
      const operationId = startupStopOperation.identity.operationId;
      const terminal = stopResume.find((operation) =>
        operation.identity.operationId === operationId && operation.phase === "terminal");
      if (!terminal) {
        throw new Error("Durable executor host-stop recovery did not prove the old host terminal");
      }
      await localConversationOwner.releaseHostStopAdmission(operationId);
      await authority.authority.releaseLifecycleAdmission(operationId);
      if (!startupStopAcceptedWorkRecovered) {
        await localConversationOwner.recoverAcceptedWorkForLifecycle();
        await jobOwnerAssembly.recoverAcceptedWorkForLifecycle();
        await mesh.recoverAcceptedWorkForLifecycle();
        startupStopAcceptedWorkRecovered = true;
      }
      jobOwnerAssembly.resumeAccepting();
      mesh.resumeAcceptingAfterLifecycle();
      localConversationOwner.resumeRecoveryAfterLifecycle();
    }
    const token = await loadOrCreateToken();
    const localConversationRpc = new LocalConversationRpcRouter({
      deviceId: authority.deviceId,
      owner: localConversationOwner.port(),
      remoteFor: (deviceId) => mesh!.firstPartyConversationFor(deviceId),
    });
    const conversationRpc = new ExecutorFirstPartyRpcRouter({
      local: localConversationRpc,
      currentAnchor: new CurrentAnchorFirstPartyRpcRouter({
        deviceId: authority.deviceId,
        currentAnchorDeviceId: () => mesh!.currentAnchorDeviceId(),
        currentOwnerReady: () => mesh!.plannedCurrentOwnerReady(),
        remoteFor: (deviceId) => mesh!.firstPartyConversationFor(deviceId),
      }),
    });
    const serverContext = createServerContext({
      config: {
        ...DEFAULT_SERVER_CONFIG,
        port: localServerPort,
        host: options.host ?? DEFAULT_SERVER_CONFIG.host,
      },
      version: ZHIXING_CLI_VERSION,
      token: token.token,
      conversationRpc,
      lifecycleShutdown: stopCoordinator,
      runtimeControl: {
        conversationStatus: (after) =>
          localConversationOwner!.port().statusHistory(after),
        conversationFinalHistory: (conversationId, afterCommitRevision) =>
          localConversationOwner!.port().finalHistory(
            conversationId,
            afterCommitRevision,
          ),
      },
      hostInfo: { logPath: isDaemonChild() ? getDefaultLogPath() : undefined },
    });
    localConversationServer = await runServer({
      context: serverContext,
      boundServer: localServerBinding,
      config: {
        ...DEFAULT_SERVER_CONFIG,
        port: localServerPort,
        host: localServerHost,
      },
      skipSignalHandlers: true,
      processInfo: {
        version: ZHIXING_CLI_VERSION,
        kind: "zhixing-local-conversation-host",
        ...(isDaemonChild() ? { logPath: getDefaultLogPath() } : {}),
        startTime: processStartTime,
        startedAt: processStartedAt,
      },
      logger: {
        info: (message) => writer.notify(`[local-session] ${message}`),
        warn: (message) => writer.notify(`[local-session] ${message}`),
        error: (message) => writer.notify(`[local-session] ${message}`),
      },
    });
    executorInternalStop.current = createExecutorInternalStopPort({
      requestId: `executor-internal:${process.pid}:${processStartedAt}`,
      timeoutMs: 30_000,
      prepare: (request) => stopCoordinator.prepare(request),
      shutdown: (reason) => localConversationServer!.shutdown(reason),
      waitForShutdown: () => localConversationServer!.waitForShutdown(),
    });
    coordinateRuntimeTrustTransition = async () => {
      const result = await coordinateManagedHostTrustTransition({
        processMode,
        expectedAdmission: initialManagedHostAdmission,
        refuseNewMessages: () => jobOwnerAssembly?.pauseAccepting(),
        requestShutdown: () => requestExecutorInternalStop({
          reason: "managed-role-changed",
          strategy: "immediate",
        }),
      });
      if (result === "stopped") {
        throw new Error("Executor Host admission changed and reached its durable terminal");
      }
    };
    await onTrustApplied();
    await localServerState.markReady({
      pid: process.pid,
      startedAt: processStartedAt,
      port: localConversationServer.server.port,
      host: localConversationServer.server.host,
    });
    await localServerState.markRunning();
    localServerHeartbeat = setInterval(() => {
      void localServerState?.heartbeat();
    }, 60_000);
    localServerHeartbeat.unref();
    if (processMode === "on-demand") {
      executorIdleTimer = setInterval(() => {
        if (executorIdleCheck) return;
        const check = (async () => {
          const anchorDeviceId = currentAnchorDeviceId();
          const localConnectionCount = localConversationServer!.server.connections.size;
          const currentAnchorConnected = anchorDeviceId !== undefined &&
            mesh!.connections.has(anchorDeviceId);
          const [hasLocalAcceptedWork, remoteAcceptedWork] =
            localConnectionCount > 0 || currentAnchorConnected
              ? [false, []] as const
              : await Promise.all([
                  localConversationOwner!.hasIdleBlockingWork(),
                  jobOwnerAssembly!.acceptedWorkItems(),
                ]);
          if (!shouldExecutorIdleExit({
            localConnectionCount,
            currentAnchorConnected,
            hasLocalAcceptedWork,
            hasRemoteAcceptedWork: remoteAcceptedWork.length > 0,
          })) return;
          await requestExecutorInternalStop({ reason: "idle", strategy: "drain" });
        })();
        executorIdleCheck = check;
        void check.catch((error) => {
          writer.notify(
            `[idle] durable Executor Host stop failed; the same operation will retry: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }).finally(() => {
          if (executorIdleCheck === check) executorIdleCheck = undefined;
        });
      }, 60_000);
      executorIdleTimer.unref();
    }
    await waitForExecutorRoleTerminal({
      server: localConversationServer,
      deviceRemoved: lifecycleShutdown,
      prepareSignalStop: () => stopCoordinator.prepare({
        requestId: `executor-signal:${process.pid}:${processStartedAt}`,
        reason: "executor-signal",
        strategy: "immediate",
        timeoutMs: 30_000,
      }).then(() => undefined),
    });
  } catch (error) {
    roleFailure = error;
  }
  const cleanupFailures: unknown[] = [];
  try {
    if (executorIdleTimer) clearInterval(executorIdleTimer);
    await executorIdleCheck?.catch(() => undefined);
    if (localServerHeartbeat) clearInterval(localServerHeartbeat);
    await localServerState?.markStopping("graceful");
    await localConversationServer?.shutdown("executor-role-stop");
    await localServerBinding?.close();
    await localServerState?.markStopped();
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    await localConversationOwner?.close();
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    evidenceHandler?.stopAccepting();
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    await localWorkspaceHost?.close();
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    if (jobOwnerLifecycle && !jobOwnerLifecycle.closed) {
      await jobOwnerLifecycle.close();
    } else if (!jobOwnerLifecycle) {
      jobOwnerAssembly?.stopAccepting();
      await jobOwnerAssembly?.close();
      await mesh?.stop();
    }
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    await dataPlane?.close();
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    await authority?.stopStorageMaintenance();
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    await mcpHub.dispose();
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    await localServerState?.cleanup();
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (roleFailure !== undefined) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [roleFailure, ...cleanupFailures],
        "Executor role and cleanup both failed",
      );
    }
    throw roleFailure;
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures,
      "Executor role cleanup failed",
    );
  }
}

export class ExecutorRuntimeSubstrate {
  constructor(private readonly options: {
    readonly config: ZhixingConfig;
    readonly credentials: ProviderCredentialProjection;
    readonly mcpHub: McpHub;
    readonly systemProtectedPaths: readonly string[];
    readonly interactions: DurableConversationInteractionObserver;
    readonly artifactStore: () => ArtifactStore;
    readonly deviceCapacity: {
      readonly interactive: AgentRuntimeCapacityBinding;
      readonly scheduler: AgentRuntimeCapacityBinding;
      readonly orchestration: AgentRuntimeCapacityBinding;
    };
  }) {}

  createConversationRuntime(
    workspaceRoot?: string | null,
    sessionId?: string,
  ): Promise<AgentRuntime> {
    const catalog = this.options.mcpHub.catalog();
    const scope = sessionId ? parseConversationId(sessionId).scope : undefined;
    const workscene =
      scope?.kind === "workscene"
        ? {
            sceneId: scope.sceneId,
            profile: powerProfile({
              id: scope.sceneId,
              name: scope.sceneId,
              hasWorkspace: workspaceRoot !== null,
            }),
          }
        : undefined;
    return createAgentRuntime({
      artifactStore: this.options.artifactStore(),
      deviceCapacity: this.options.deviceCapacity.interactive,
      orchestrationCapacity: this.options.deviceCapacity.orchestration,
      providerConfiguration: {
        config: this.options.config,
        credentials: this.options.credentials,
      },
      profile:
        workscene?.profile ??
        mainProfile({ hasWorkspace: workspaceRoot !== null }),
      extraTools: mapMcpTools(this.options.mcpHub),
      executionMcpServers: catalog.map(({ server }) => server.serverId).sort(),
      confirmationLifecycleObserver: this.options.interactions,
      systemProtectedPaths: this.options.systemProtectedPaths,
      runtimeKind: "conversation",
      ...(workspaceRoot === undefined ? {} : { workspace: workspaceRoot }),
      ...(workscene
        ? {
            primaryRole: "power",
            worksceneIdentity: { sceneId: workscene.sceneId },
          }
        : {}),
    });
  }

  createJobRuntime(
    instruction: import("@zhixing/core/contracts").JobExecutionInstruction,
    confirmationBroker: import("@zhixing/core").IConfirmationBroker,
  ): Promise<AgentRuntime> {
    const catalog = this.options.mcpHub.catalog();
    let extraTools = mapMcpTools(this.options.mcpHub);
    const baseProfile = mainProfile();
    const requested = instruction.tools
      ? new Set(instruction.tools)
      : undefined;
    if (requested) {
      const available = new Set([
        ...baseProfile.enabledTools,
        ...extraTools.map((tool) => tool.name),
      ]);
      const unknown = [...requested].filter((tool) => !available.has(tool));
      if (unknown.length > 0) {
        throw new TypeError(
          `Job requested unavailable tools: ${unknown.sort().join(", ")}`,
        );
      }
      extraTools = extraTools.filter((tool) => requested.has(tool.name));
    }
    const config =
      instruction.model && this.options.config.llm
        ? {
            ...this.options.config,
            llm: {
              ...this.options.config.llm,
              main: {
                ...this.options.config.llm.main,
                model: instruction.model,
              },
            },
          }
        : this.options.config;
    return createAgentRuntime({
      artifactStore: this.options.artifactStore(),
      deviceCapacity: this.options.deviceCapacity.scheduler,
      orchestrationCapacity: this.options.deviceCapacity.orchestration,
      providerConfiguration: {
        config,
        credentials: this.options.credentials,
      },
      profile: {
        ...baseProfile,
        enabledTools: requested
          ? baseProfile.enabledTools.filter((tool) => requested.has(tool))
          : baseProfile.enabledTools,
      },
      extraTools,
      executionMcpServers: catalog.map(({ server }) => server.serverId).sort(),
      confirmationBroker,
      systemProtectedPaths: this.options.systemProtectedPaths,
      runtimeKind: "ephemeral",
    });
  }

  capabilityCatalog(): {
    readonly tools: readonly string[];
    readonly mcpServers: readonly string[];
  } {
    return {
      tools: [
        ...new Set([
          ...mainProfile().enabledTools,
          ...mapMcpTools(this.options.mcpHub).map((tool) => tool.name),
        ]),
      ].sort(),
      mcpServers: this.options.mcpHub.catalog()
        .map(({ server }) => server.serverId)
        .sort(),
    };
  }
}

export { ExecutorJobOwnerLifecycle } from "./executor-job-owner.js";

function mapMcpTools(hub: McpHub): ToolDefinition[] {
  return hub.catalog().flatMap(({ server, tools }) =>
    mapServerTools(server, tools, hub.callTool));
}

function assertAcceptedWorkSubset(
  current: readonly HostStopAcceptedWorkItem[],
  frozen: readonly HostStopAcceptedWorkItem[],
  label: string,
): void {
  const expected = new Map(frozen.map((item) => [item.id, item.revision]));
  for (const item of current) {
    if (expected.get(item.id) !== item.revision) {
      throw new Error(`${label} observed accepted work outside the frozen generation`);
    }
  }
}
