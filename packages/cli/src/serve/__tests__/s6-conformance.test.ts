import path from "node:path";
import {
  ConfirmationBroker,
  type AgentYield,
  type ChannelChallengeMessage,
  type ChannelRegistry,
  type Message,
  type RunResult,
} from "@zhixing/core";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
  FileResumableArtifactReceiver,
} from "@zhixing/core/authority";
import type {
  AuthorityCallContext,
  AuthorityCapability,
  ChannelResponderRef,
  ExecutionStatusNotice,
  ExecutionRef,
  SecretRef,
  SecretStorePort,
  StreamFrame,
  TaskDefinition,
  TrustRuleSnapshot,
} from "@zhixing/core/contracts";
import {
  createJobCommitFence,
  createSignedCapabilityDescriptor,
  createSignedChannelChallengeToken,
  createSignedExecutorVersionInventory,
  createSignedTrustRuleSnapshot,
  jobDeliveryPlanDigest,
  ownerControlRequestDigest,
  protocolDigest,
  type ExecutorCapabilitySnapshot,
  type ProtocolSigner,
  type UnsignedJobEnvelope,
} from "@zhixing/core/protocol";
import {
  AssignmentStreamSpool,
  AssignmentStreamWriter,
} from "@zhixing/executor/assignment-stream-spool";
import {
  ConversationAssignmentLedger,
  DataPlaneTicketRegistry,
  InProcessAssignmentSubmission,
} from "@zhixing/executor";
import type { SecureMeshConnection } from "@zhixing/mesh";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import {
  ConversationManager,
  createInitialControlEnvelope,
  type AssignmentSubmissionAuthorizer,
  type InProcessDispatchContextFactory,
  type RuntimeFactory,
  type SessionRuntime,
} from "@zhixing/owner-kernel";
import {
  InProcessJobDispatcher,
  JobJournal,
  type JobAssignmentPlan,
} from "@zhixing/owner-kernel/job-assignment";
import { projectSessionTurn } from "@zhixing/rpc";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { setupAuthorityRuntime, type AuthorityRuntimeStack } from "../../setup-delivery.js";
import {
  ASSIGNMENT_ARTIFACT_SERVICE,
  RUN_EXECUTOR_SERVICE,
  RUN_SUBMISSION_SERVICE,
  MeshRunExecutorPort,
  MeshRunSubmissionPort,
  createAssignmentArtifactServiceHandler,
  createRunExecutorMeshServiceHandler,
  createRunSubmissionMeshServiceHandler,
} from "../assignment-mesh-adapter.js";
import {
  ASSIGNMENT_STREAM_SERVICE,
  AssignmentStreamMeshClient,
  createAssignmentStreamServiceHandler,
  createDataPlaneAssignmentStreamAuthorizer,
} from "../assignment-stream-mesh.js";
import { ConversationAssignmentWorker } from "../conversation-assignment-worker.js";
import {
  ConversationProtocolRuntime,
  DurableConversationInteractionObserver,
  type RemoteConversationExecutionDirectory,
} from "../conversation-protocol-runtime.js";
import {
  DATA_PLANE_TICKET_SERVICE,
  DataPlaneTicketMeshClient,
  createDataPlaneTicketServiceHandler,
} from "../data-plane-ticket-mesh.js";
import { ExecutorDataPlaneRuntime } from "../executor-data-plane-runtime.js";
import {
  ExecutionStatusHub,
  FirstPartyFinalitySession,
} from "../first-party-finality-session.js";
import { JobStatusDirectory } from "../job-status-directory.js";
import { createLosslessDataPlaneComposition } from "../lossless-data-plane-composition.js";
import type { MeshRuntimeAssembly } from "../mesh-runtime-assembly.js";
import { createOwnerControlAuthorizer } from "../owner-control-authorizer.js";

const NOW = "2026-07-28T00:00:00.000Z";
const EXPIRY = "2026-07-28T02:00:00.000Z";
const DIGEST = `sha256:${"2".repeat(64)}` as const;
const DURABLE_IO_TEST_TIMEOUT_MS = 120_000;

const executorReadiness = {
  tools: [] as string[],
  mcpServers: [] as string[],
  credentialBindings: [],
  deviceScopedCredentialBindingIds: [] as string[],
  credentialGeneration: null,
};

const runtimeAuthorityFacts = {
  executionPermissionRules: () => [],
  securitySnapshot: () => ({
    contextId: { kind: "main" as const },
    workspacePath: null,
    permissionRules: [],
    builtinRules: [],
    rateLimits: [],
    confirmations: [],
  }),
  executionProfile: () => ({
    tools: [],
    mcpServers: [],
    providerIds: [],
  }),
} satisfies Pick<
  SessionRuntime,
  "executionPermissionRules" | "securitySnapshot" | "executionProfile"
>;

const responder: ChannelResponderRef = {
  channelId: "feishu",
  platformSubject: "user-fixed",
};

type ExecutionTopology = "local" | "remote";
type ConversationSurface = "first-party" | "channel";

class MemorySecretStore implements SecretStorePort {
  readonly #values = new Map<string, string>();

  async put(ref: SecretRef, value: string): Promise<void> {
    this.#values.set(`${ref.kind}/${ref.bindingId}`, value);
  }

  async get(ref: SecretRef): Promise<string | null> {
    return this.#values.get(`${ref.kind}/${ref.bindingId}`) ?? null;
  }

  async delete(ref: SecretRef): Promise<void> {
    this.#values.delete(`${ref.kind}/${ref.bindingId}`);
  }

  async list(): Promise<SecretRef[]> {
    return [];
  }

  async unlockState(): Promise<"unlocked"> {
    return "unlocked";
  }
}

type ServiceHandler = (
  payload: Uint8Array,
  connection: SecureMeshConnection,
  signal: AbortSignal,
) => Promise<Uint8Array>;

function serviceClient(
  handlers: ReadonlyMap<string, ServiceHandler>,
  peerDeviceId: string,
  requestCounts?: Map<string, number>,
  failRequest?: (
    serviceId: string,
    payload: Uint8Array,
    call: number,
  ) => boolean,
): MeshServiceClient {
  const connection = {
    peer: { deviceId: peerDeviceId, publicKey: "test" },
  } as unknown as SecureMeshConnection;
  return {
    async request(serviceId, payload, signal) {
      const call = (requestCounts?.get(serviceId) ?? 0) + 1;
      requestCounts?.set(serviceId, call);
      if (failRequest?.(serviceId, payload, call)) {
        throw new Error(`Injected ${serviceId} transport interruption`);
      }
      const handler = handlers.get(serviceId);
      if (!handler) throw new Error(`S6 mesh service is unavailable: ${serviceId}`);
      return handler(
        payload,
        connection,
        signal ?? new AbortController().signal,
      );
    },
  };
}

function authorityWithExecutorId(
  authority: AuthorityRuntimeStack,
  executorId: string,
): AuthorityRuntimeStack {
  return new Proxy(authority, {
    get(target, property, receiver) {
      return property === "executorId"
        ? executorId
        : Reflect.get(target, property, receiver);
    },
  });
}

function fakeChannels(sendChallenge: ReturnType<typeof vi.fn>): ChannelRegistry {
  return {
    get(channelId: string) {
      return channelId === "feishu"
        ? { id: "feishu", sendChallenge }
        : undefined;
    },
  } as unknown as ChannelRegistry;
}

function createRuntime(
  home: string,
  interactions: DurableConversationInteractionObserver,
  surface: ConversationSurface,
): SessionRuntime {
  const broker = new ConfirmationBroker({ lifecycleObserver: interactions });
  if (surface === "first-party") {
    broker.onRequest((request) => {
      queueMicrotask(() => broker.resolve(request.id, { kind: "allow-once" }));
    });
  }
  const assistant: Message = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
  };
  return {
    ...runtimeAuthorityFacts,
    sessionId: `s6-runtime-${surface}`,
    confirmationBroker: broker,
    async *run(messages): AsyncGenerator<AgentYield, RunResult> {
      const createdAt = Date.parse(NOW);
      await broker.requestConfirmation({
        id: `confirmation-${surface}`,
        tool: "bash",
        toolInput: { command: "pwd" },
        workingDirectory: home,
        display: {
          title: "Run?",
          body: { kind: "generic", summary: "pwd" },
          cwd: home,
        },
        options: [{ kind: "allow-once", label: "Allow" }],
        sessionType: "interactive",
        contextId: { kind: "main" },
        createdAt,
        expiresAt: createdAt + 60_000,
      });
      yield { type: "text_delta", text: "done" };
      return {
        agentResult: {
          reason: "completed",
          message: assistant,
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        runRecord: {
          timestamp: NOW,
          messages: [messages.at(-1)!, assistant],
          usage: { inputTokens: 1, outputTokens: 1 },
          source: surface === "channel" ? "channel" : "interactive",
        },
        newMessages: [assistant],
        durationMs: 1,
      };
    },
    abort: () => false,
    async dispose() {},
  };
}

function executorSnapshot(
  executorId: string,
  signer: ProtocolSigner,
  permissionSnapshotVersion: number,
): ExecutorCapabilitySnapshot {
  return {
    descriptor: createSignedCapabilityDescriptor(
      {
        executorId,
        revision: 1,
        protocolVersion: "1",
        workspaces: [],
        tools: [],
        mcpServers: [],
        credentialBindings: [],
        evidenceCapabilities: [],
        at: NOW,
      },
      signer,
    ),
    inventory: createSignedExecutorVersionInventory(
      {
        executorId,
        inventoryRevision: 1,
        capabilityRevision: 1,
        configVersions: {
          runtimeConfigRev: 1,
          modelProfileRev: 1,
          policyRev: 1,
        },
        assetVersions: {
          skillsRev: 1,
          rubricsRev: 1,
          promptAssetsRev: 1,
        },
        permissionSnapshotHighWater: permissionSnapshotVersion,
        credentialBindingRevisions: [],
        at: NOW,
      },
      signer,
    ),
  };
}

function createExecutorLedger(input: {
  readonly authority: AuthorityRuntimeStack;
  readonly executorId: string;
  readonly log: FileAuthorityCommitLog;
  readonly artifacts: FileArtifactStore;
  readonly snapshotFor: (executorId: string) => ExecutorCapabilitySnapshot | undefined;
  readonly permissionSnapshotFor: (digest: string) => TrustRuleSnapshot | undefined;
  readonly tickets: DataPlaneTicketRegistry;
}): ConversationAssignmentLedger {
  return new ConversationAssignmentLedger({
    log: input.log,
    artifacts: input.artifacts,
    executorId: input.executorId,
    signer: input.authority.signer,
    verifier: input.authority.verifier,
    ownerControl: createOwnerControlAuthorizer(
      input.authority.verifier,
      () => NOW,
    ),
    snapshotFor: input.snapshotFor,
    permissionSnapshotFor: input.permissionSnapshotFor,
    runtimeBindingGuard: () => undefined,
    dataPlaneTickets: input.tickets,
    clock: () => NOW,
  });
}

interface RemoteExecutorHarness {
  readonly authorityView: AuthorityRuntimeStack;
  readonly dataPlane: ExecutorDataPlaneRuntime;
  readonly ledger: ConversationAssignmentLedger;
  readonly directory: RemoteConversationExecutionDirectory;
  readonly mesh: MeshRuntimeAssembly;
  close(): Promise<void>;
}

async function createRemoteConversationExecutor(input: {
  readonly home: string;
  readonly authority: AuthorityRuntimeStack;
  readonly protocol: ConversationProtocolRuntime;
  readonly runtimeFactory: RuntimeFactory;
  readonly interactions: DurableConversationInteractionObserver;
}): Promise<RemoteExecutorHarness> {
  const executorId = "executor:s6-remote";
  const executorDeviceId = "device:s6-remote";
  const executorRoot = path.join(input.home, "remote-executor");
  const artifacts = new FileArtifactStore(path.join(executorRoot, "artifacts"));
  const log = new FileAuthorityCommitLog(
    path.join(executorRoot, "authority"),
    artifacts,
  );
  const permissions = new Map<string, TrustRuleSnapshot>();
  let snapshot = executorSnapshot(executorId, input.authority.signer, 0);
  const executorAuthority = {
    ...input.authority,
    executorId,
    executorLog: log,
    artifacts,
    executorCapabilities: {
      snapshotFor: (candidate: string) =>
        candidate === executorId ? snapshot : undefined,
    },
    permissionSnapshotFor: (digest: string) => permissions.get(digest),
  } as AuthorityRuntimeStack;
  const dataPlane = new ExecutorDataPlaneRuntime({
    zhixingHome: executorRoot,
    authority: executorAuthority,
    module: {
      AssignmentStreamSpool,
      AssignmentStreamWriter,
      DataPlaneTicketRegistry,
    },
    clock: () => NOW,
  });
  const ledger = createExecutorLedger({
    authority: input.authority,
    executorId,
    log,
    artifacts,
    snapshotFor: (candidate) => candidate === executorId ? snapshot : undefined,
    permissionSnapshotFor: (digest) => permissions.get(digest),
    tickets: dataPlane.tickets,
  });
  dataPlane.bindLedger(ledger);

  const ownerReceiver = new FileResumableArtifactReceiver(
    input.authority.artifacts,
    path.join(input.home, "owner-transfer-partials"),
    { maxArtifactBytes: 512 * 1024 * 1024 },
  );
  const executorReceiver = new FileResumableArtifactReceiver(
    artifacts,
    path.join(executorRoot, "transfer-partials"),
    { maxArtifactBytes: 512 * 1024 * 1024 },
  );
  const ownerHandlers = new Map<string, ServiceHandler>();
  const executorHandlers = new Map<string, ServiceHandler>();
  const ownerToExecutor = serviceClient(
    executorHandlers,
    input.authority.deviceId,
  );
  const executorToOwner = serviceClient(ownerHandlers, executorDeviceId);
  const authorizationForOwner = (assignmentId: string) =>
    input.protocol.assignmentArtifactAuthority(assignmentId);
  const authorizationForExecutor = (assignmentId: string) =>
    ledger.assignmentArtifactAuthority(assignmentId);

  ownerHandlers.set(
    ASSIGNMENT_ARTIFACT_SERVICE,
    createAssignmentArtifactServiceHandler({
      artifacts: input.authority.artifacts,
      receiver: ownerReceiver,
      verifier: input.authority.verifier,
      authorize: () => undefined,
      clock: () => Date.parse(NOW),
    }),
  );
  executorHandlers.set(
    ASSIGNMENT_ARTIFACT_SERVICE,
    createAssignmentArtifactServiceHandler({
      artifacts,
      receiver: executorReceiver,
      verifier: input.authority.verifier,
      authorize: () => undefined,
      clock: () => Date.parse(NOW),
    }),
  );

  const submission = new MeshRunSubmissionPort({
    client: executorToOwner,
    artifacts,
    receiver: executorReceiver,
    signer: input.authority.signer,
    localDeviceId: executorDeviceId,
    peerDeviceId: input.authority.deviceId,
    authorizationFor: authorizationForExecutor,
    clock: () => Date.parse(NOW),
  });
  const worker = new ConversationAssignmentWorker({
    ledger,
    runtimeFactory: input.runtimeFactory,
    artifacts,
    submissionFor: () => submission,
    finalizeUsage: async () => ({
      reportDigest: DIGEST,
      upToUsageSeq: 0,
    }),
    InProcessAssignmentSubmission,
    interactions: input.interactions,
    createStream: (stream) => dataPlane.createStream(stream),
  });
  executorHandlers.set(
    RUN_EXECUTOR_SERVICE,
    createRunExecutorMeshServiceHandler({
      port: ledger,
      guard: ledger,
      artifacts,
      verifier: input.authority.verifier,
      signer: input.authority.signer,
      localDeviceId: executorDeviceId,
      artifactAuthorizationFor: authorizationForExecutor,
      authorizePeer: (deviceId) => deviceId === input.authority.deviceId,
      onDispatchAccepted: (envelope) => worker.accept(envelope),
      clock: () => Date.parse(NOW),
    }),
  );
  ownerHandlers.set(
    RUN_SUBMISSION_SERVICE,
    createRunSubmissionMeshServiceHandler({
      port: input.protocol.submissionMeshRole().submission,
      guard: input.protocol.submissionMeshRole().submissionGuard,
      artifacts: input.authority.artifacts,
      executorIdForPeer: (deviceId) =>
        deviceId === executorDeviceId ? executorId : undefined,
    }),
  );
  executorHandlers.set(
    ASSIGNMENT_STREAM_SERVICE,
    createAssignmentStreamServiceHandler({
      spool: dataPlane.spool,
      authorize: createDataPlaneAssignmentStreamAuthorizer({
        tickets: dataPlane.tickets,
        surfacePrincipalFor: (connection) =>
          `surface:device:${connection.peer.deviceId}`,
        ownerMayPresentSurfaceTicket: (connection) =>
          connection.peer.deviceId === input.authority.deviceId,
        authorizeOwnerRelay: async (request) => {
          await ledger.authorizeOwnerRelay({
            assignmentId: request.assignmentId,
            consumer: request.consumer as Extract<
              typeof request.consumer,
              { readonly kind: "owner-relay" }
            >,
            ownerDeviceId: request.connection.peer.deviceId,
          });
          return {};
        },
      }),
    }),
  );
  executorHandlers.set(
    DATA_PLANE_TICKET_SERVICE,
    createDataPlaneTicketServiceHandler({
      tickets: dataPlane.tickets,
      verifier: input.authority.verifier,
      operations: worker,
      authorizeOwner: (connection) =>
        connection.peer.deviceId === input.authority.deviceId,
      surfacePrincipalFor: (connection) =>
        `surface:device:${connection.peer.deviceId}`,
    }),
  );

  const executor = new MeshRunExecutorPort({
    client: ownerToExecutor,
    artifacts: input.authority.artifacts,
    receiver: ownerReceiver,
    verifier: input.authority.verifier,
    signer: input.authority.signer,
    localDeviceId: input.authority.deviceId,
    peerDeviceId: executorDeviceId,
    authorizationFor: authorizationForOwner,
    clock: () => Date.parse(NOW),
  });
  const remoteDataPlane = {
    dataPlaneForExecutor(candidate: string) {
      if (candidate !== executorId) {
        throw new Error("S6 remote data plane selected another executor");
      }
      return {
        stream: new AssignmentStreamMeshClient(ownerToExecutor),
        tickets: new DataPlaneTicketMeshClient(ownerToExecutor),
      };
    },
  } as MeshRuntimeAssembly;
  const directory: RemoteConversationExecutionDirectory = {
    async candidates() {
      return [{
        executorId,
        executor,
        async synchronizePermission(permission) {
          permissions.set(permission.digest, permission);
          snapshot = executorSnapshot(
            executorId,
            input.authority.signer,
            permission.snapshotVersion,
          );
          return snapshot;
        },
      }];
    },
    forExecutor(candidate) {
      return candidate === executorId
        ? {
            executorId,
            executor,
            async synchronizePermission(permission) {
              permissions.set(permission.digest, permission);
              snapshot = executorSnapshot(
                executorId,
                input.authority.signer,
                permission.snapshotVersion,
              );
              return snapshot;
            },
          }
        : undefined;
    },
  };
  await dataPlane.start();
  return {
    authorityView: input.authority,
    dataPlane,
    ledger,
    directory,
    mesh: remoteDataPlane,
    async close() {
      await worker.close();
      await dataPlane.close();
    },
  };
}

async function runConversationScenario(
  surface: ConversationSurface,
  topology: ExecutionTopology,
) {
  const home = await createTempDir(`s6-${surface}-${topology}`);
  const authority = await setupAuthorityRuntime({
    zhixingHome: home,
    secretStore: new MemorySecretStore(),
    executorReadiness,
    enableLocalExecutor: topology === "local",
    clock: () => NOW,
  });
  const interactions = new DurableConversationInteractionObserver();
  const runtime = createRuntime(home, interactions, surface);
  const runtimeFactory: RuntimeFactory = { create: async () => runtime };
  const statuses: ExecutionStatusNotice[] = [];
  const finals: Array<{
    readonly conversationId: string;
    readonly runId: string;
    readonly commitRevision: number;
    readonly digest: string;
  }> = [];
  const firstPartyFrames: StreamFrame[] = [];
  let manager!: ConversationManager;
  let localDataPlane: ExecutorDataPlaneRuntime | undefined;
  if (topology === "local") {
    localDataPlane = new ExecutorDataPlaneRuntime({
      zhixingHome: home,
      authority,
      module: {
        AssignmentStreamSpool,
        AssignmentStreamWriter,
        DataPlaneTicketRegistry,
      },
      clock: () => NOW,
    });
  }
  const jobStatus = new JobStatusDirectory();
  let protocol!: ConversationProtocolRuntime;
  const statusHub = new ExecutionStatusHub({
    conversationHistory: (requests) => protocol.statusHistory(requests),
    jobHistory: (requests) => jobStatus.statusHistory(requests),
    deliveryHistory: async () => [],
  });
  jobStatus.onStatus((notice) => statusHub.publish(notice));
  protocol = new ConversationProtocolRuntime({
    authority,
    manager: () => manager,
    interactions,
    ...(topology === "local"
      ? {
          localExecutor: {
            ConversationAssignmentLedger,
            InProcessAssignmentSubmission,
            dataPlaneTickets: localDataPlane!.tickets,
            createStream: (stream: {
              readonly assignmentId: string;
              readonly ref: ExecutionRef;
            }) => localDataPlane!.createStream(stream),
          },
        }
      : {}),
    onStatus: (notice) => {
      statuses.push(notice);
      statusHub.publish(notice);
    },
    onFinal: (frame) => {
      finals.push(frame);
    },
    onFirstPartyFrame: (frame) => {
      firstPartyFrames.push(frame);
    },
    createFirstPartyFinality: (input) =>
      new FirstPartyFinalitySession({ sources: statusHub, ...input }),
  });
  let remote: RemoteExecutorHarness | undefined;
  if (topology === "local") {
    localDataPlane!.bindLedger(protocol.executorLedger());
    await localDataPlane!.start();
  } else {
    remote = await createRemoteConversationExecutor({
      home,
      authority,
      protocol,
      runtimeFactory,
      interactions,
    });
    protocol.bindRemoteExecution(remote.directory);
  }

  let challenge: ChannelChallengeMessage | undefined;
  const sendChallenge = vi.fn(async (input) => {
    challenge = input;
    return { success: true as const, messageId: "message-s6" };
  });
  const channels = fakeChannels(sendChallenge);
  const composition = createLosslessDataPlaneComposition({
    authority,
    ...(localDataPlane ? { local: localDataPlane } : {}),
    mesh: () => remote?.mesh,
    interactions,
    protocol,
    channels: () => channels,
    jobStatus,
  });
  composition.runtime.bindChannels(channels);

  const committed = new Map<string, { runIndex: number; shardId: string }>();
  manager = new ConversationManager(runtimeFactory, undefined, {
    loadHistory: async () => undefined,
    initTranscript: async () => {},
    appendRun: async () => ({ runIndex: 0, shardId: "legacy" }),
    appendCommittedRun: async (_conversationId, record) => {
      const existing = committed.get(record.runId);
      if (existing) return { ...existing, appended: false };
      const accepted = { runIndex: record.runIndex, shardId: "durable" };
      committed.set(record.runId, accepted);
      return { ...accepted, appended: true };
    },
    durableTurnExecutor: protocol,
  });
  const conversationId = `conversation-${surface}-${topology}`;
  const source = {
    principal: {
      surfacePrincipal: "rpc:owner",
      deviceId: authority.deviceId,
      connectionId: `connection:${topology}`,
    },
  };
  await authority.controlAdmission.apply({
    envelope: createInitialControlEnvelope({
      requestId: `session-create:${surface}:${topology}`,
      source,
      at: NOW,
      body: { t: "session-create", requestedName: conversationId },
    }),
    source,
    prepare: () => ({
      result: {
        v: 1,
        status: "ok",
        body: { t: "session-create", conversationId },
      },
      authorityRevision: 1,
    }),
  });
  const managed = await manager.getOrCreate(conversationId);
  const turn = projectSessionTurn({
    manager,
    managed,
    text: "run",
    turnId: `s6:${surface}:${topology}`,
    runOptions: {
      source: surface === "channel" ? "channel" : "interactive",
      surfacePrincipal: "surface:rpc:owner",
      turnContext: {
        turnId: `s6:${surface}:${topology}`,
        ...(surface === "channel"
          ? {
              emissionTarget: { channelId: "feishu", to: "user-fixed" },
              turnOrigin: {
                channel: "feishu",
                target: { channelId: "feishu", to: "user-fixed" },
                triggeredBy: responder.platformSubject,
              },
            }
          : {}),
      },
    },
    notify: () => {},
  });
  if (surface === "channel") {
    await vi.waitFor(() => expect(sendChallenge).toHaveBeenCalledOnce());
    const current = challenge;
    if (!current) throw new Error("S6 channel scenario did not emit a challenge");
    await composition.coordinator.handleChallengeAction({
      token: current.token,
      responder,
      decision: { allowed: true },
    });
  }
  const settled = await turn;
  if (settled.kind === "error") throw settled.error;
  expect(settled.kind).toBe("settled");
  await protocol.recover();

  const authorityEntries = (await authority.authorityLog.readAll())
    .flatMap((commit) => commit.entries);
  const assigned = authorityEntries
    .map((entry) => entry.body as { t?: string; assignmentId?: string; runId?: string })
    .find((entry) => entry.t === "assigned");
  expect(assigned?.assignmentId).toBeTruthy();
  expect(statuses.length).toBeGreaterThan(0);
  expect(finals).toHaveLength(1);
  const final = finals[0]!;
  expect(statuses.every(
    (notice) =>
      notice.ref.execution === "conversation" &&
      notice.ref.conversationId === final.conversationId &&
      notice.ref.runId === final.runId,
  )).toBe(true);
  if (surface === "first-party") {
    expect(firstPartyFrames.some(
      (frame) => frame.payload.kind === "provisional-final",
    )).toBe(true);
  } else {
    expect(sendChallenge).toHaveBeenCalledOnce();
  }

  await composition.close();
  await remote?.close();
  await localDataPlane?.close();
  authority.stopStorageMaintenance();
  return {
    assignmentId: assigned!.assignmentId!,
    statuses,
    finals,
    frames: firstPartyFrames,
  };
}

function createJobUnsignedEnvelope(input: {
  readonly signer: ProtocolSigner;
  readonly executorId: string;
  readonly permissionSnapshot: TrustRuleSnapshot;
}): UnsignedJobEnvelope {
  const assignmentId = "job-assignment-s6";
  const delivery = {
    kind: "channel" as const,
    channel: "feishu",
    to: "user-fixed",
  };
  const manifestBody = {
    v: 1 as const,
    baseRef: {
      execution: "job" as const,
      taskId: "task-s6",
      jobRunId: "job-run-s6",
      taskRevision: 1,
    },
    requires: {
      runtimeConfigRev: 1,
      modelProfileRev: 1,
      policyRev: 1,
      skillsRev: 1,
      rubricsRev: 1,
      promptAssetsRev: 1,
      permissionSnapshotVersion: input.permissionSnapshot.snapshotVersion,
    },
    protocolVersion: "1",
    tools: [],
    mcpServers: [],
    environment: {},
    credentialBindings: [],
  };
  const controlBody = {
    v: 1 as const,
    controlLeaseId: "job-control-s6",
    assignmentId,
    authority: {
      execution: "job" as const,
      taskId: "task-s6",
      anchorEpoch: 1,
    },
    renewalSeq: 1,
    issuedAt: NOW,
    expiry: EXPIRY,
  };
  const permissionBody = {
    v: 1 as const,
    snapshotVersion: input.permissionSnapshot.snapshotVersion,
    snapshotDigest: input.permissionSnapshot.digest,
    binding: {
      execution: "job" as const,
      jobRunId: "job-run-s6",
      taskId: "task-s6",
      anchorEpoch: 1,
    },
    assignmentId,
    executorId: input.executorId,
    controlLeaseId: controlBody.controlLeaseId,
    issuedAt: NOW,
    expiry: EXPIRY,
  };
  const capabilityBody = {
    v: 1 as const,
    capId: "job-capability-s6",
    executorId: input.executorId,
    scope: { execution: "job" as const, taskId: "task-s6" },
    anchorEpoch: 1,
    methods: [
      "submission.mirrorInteractions",
      "submission.reportStarted",
      "submission.submitBundle",
      "submission.submitCancelProof",
    ] as AuthorityCapability<"job">["methods"],
    resources: ["task:task-s6"] as AuthorityCapability<"job">["resources"],
    assignmentId,
    issuedAt: NOW,
    expiry: EXPIRY,
  };
  const leaseBody = {
    v: 1 as const,
    reservationId: "job-reservation-s6",
    admissionClass: "scheduler" as const,
    workload: { kind: "job" as const, id: "job-run-s6", attempt: 1 },
    scopeBinding: {
      kind: "job" as const,
      taskId: "task-s6",
      anchorEpoch: 1,
    },
    audience: { executorId: input.executorId },
    budget: { maxCalls: 20, maxTokens: 10_000 },
    domain: { kind: "anchor" as const, anchorEpoch: 1 },
    activation: { kind: "assignment" as const, assignmentId },
    issuedAt: NOW,
    expiry: EXPIRY,
  };
  const lease = {
    ...leaseBody,
    digest: protocolDigest("ResourceLease", 1, leaseBody),
  };
  return {
    v: 1,
    execution: "job",
    assignmentId,
    executorId: input.executorId,
    manifest: {
      ...manifestBody,
      digest: protocolDigest("ExecutionManifest", 1, manifestBody),
    },
    controlLease: {
      ...controlBody,
      signature: input.signer.sign("ControlLease", 1, controlBody),
    },
    permissionLease: {
      ...permissionBody,
      signature: input.signer.sign(
        "PermissionSnapshotLease",
        1,
        permissionBody,
      ),
    },
    capabilities: [{
      ...capabilityBody,
      signature: input.signer.sign("AuthorityCapability", 1, capabilityBody),
    }],
    resourceLease: {
      ...lease,
      signature: input.signer.sign("ResourceLease", 1, lease),
    },
    dependencyArtifacts: [],
    issuedAt: NOW,
    work: {
      t: "job",
      jobRunId: "job-run-s6",
      taskId: "task-s6",
      fence: createJobCommitFence({
        taskId: "task-s6",
        jobRunId: "job-run-s6",
        scheduledFor: NOW,
        taskRevision: 1,
        deliveryPlanDigest: jobDeliveryPlanDigest(delivery),
        anchorEpoch: 1,
        assignmentId,
        executorId: input.executorId,
      }),
      instruction: { kind: "agent-turn", prompt: "perform scheduled work" },
    },
  };
}

function jobDispatchContexts(input: {
  readonly signer: ProtocolSigner;
  readonly ownerDeviceId: string;
  readonly envelope: UnsignedJobEnvelope;
}): InProcessDispatchContextFactory {
  return {
    create(assignmentId, method, request) {
      const scope = input.envelope.controlLease.authority;
      const requestDigest = ownerControlRequestDigest({
        method,
        assignmentId,
        authority: scope,
        requestId: request.requestId,
        body: request.body,
      });
      const payload = {
        v: 1 as const,
        assignmentId,
        scope,
        methods: [method],
        callerDeviceId: input.ownerDeviceId,
        requestId: request.requestId,
        requestDigest,
        controlLease: input.envelope.controlLease,
        issuedAt: NOW,
        expiry: EXPIRY,
      };
      return {
        principal: {
          kind: "owner-control",
          grant: {
            ...payload,
            signature: input.signer.sign("OwnerControlGrant", 1, payload),
          },
        },
        requestId: request.requestId,
        deadlineAt: EXPIRY,
      };
    },
  };
}

function submissionContext(capability: AuthorityCapability): AuthorityCallContext {
  return {
    principal: { kind: "assignment", capability },
    requestId: "job-submission-s6",
    deadlineAt: EXPIRY,
  };
}

async function runJobScenario(
  topology: ExecutionTopology,
  interactive: boolean,
  probeCrossDomain = false,
) {
  const home = await createTempDir(`s6-job-${topology}-${interactive}`);
  const authority = await setupAuthorityRuntime({
    zhixingHome: home,
    secretStore: new MemorySecretStore(),
    executorReadiness,
    clock: () => NOW,
  });
  const permissionSnapshot = createSignedTrustRuleSnapshot(
    { snapshotVersion: 1, rules: [], generatedAt: NOW },
    authority.signer,
  );
  await authority.installPermissionSnapshot(permissionSnapshot);
  const dataPlane = new ExecutorDataPlaneRuntime({
    zhixingHome: home,
    authority,
    module: {
      AssignmentStreamSpool,
      AssignmentStreamWriter,
      DataPlaneTicketRegistry,
    },
    clock: () => NOW,
  });
  const snapshot = await authority.currentExecutorSnapshot();
  const ledger = createExecutorLedger({
    authority,
    executorId: authority.executorId,
    log: authority.executorLog,
    artifacts: authority.artifacts,
    snapshotFor: (candidate) =>
      candidate === authority.executorId ? snapshot : undefined,
    permissionSnapshotFor: authority.permissionSnapshotFor,
    tickets: dataPlane.tickets,
  });
  dataPlane.bindLedger(ledger);
  await dataPlane.start();

  const submissionAuthorizer: AssignmentSubmissionAuthorizer = {
    authenticate(context, identity) {
      if (
        context.principal.kind !== "assignment" ||
        context.principal.capability.assignmentId !== identity.assignmentId ||
        !context.principal.capability.methods.includes(identity.method)
      ) {
        throw new Error("S6 job submission authentication failed");
      }
    },
    authorize(context, authorization) {
      this.authenticate(context, authorization);
    },
  };
  const journal = new JobJournal({
    taskId: "task-s6",
    anchorEpoch: 1,
    log: authority.authorityLog,
    artifacts: authority.artifacts,
    signer: authority.signer,
    verifier: authority.verifier,
    snapshotFor: (candidate) =>
      candidate === authority.executorId ? snapshot : undefined,
    submission: submissionAuthorizer,
    ingress: { authorize() {} },
    delivery: authority.participant,
    clock: () => NOW,
  });
  const definition: TaskDefinition = {
    taskId: "task-s6",
    taskRevision: 1,
    state: "enabled",
    definition: {
      kind: "user",
      ...(interactive
        ? {
            origin: { channelId: "feishu", to: "user-fixed" },
            interactionResponder: responder,
          }
        : {}),
      spec: {
        name: "scheduled work",
        enabled: true,
        priority: "normal",
        schedule: { kind: "interval", everyMs: 60_000 },
        action: { kind: "agent-turn", prompt: "perform scheduled work" },
        delivery: {
          kind: "channel",
          channel: "feishu",
          to: "user-fixed",
        },
      },
    },
  };
  const surfaceContext: AuthorityCallContext = {
    principal: {
      kind: "surface",
      surfacePrincipal: "surface:s6",
      connectionId: "connection:s6",
    },
    requestId: "define-job-s6",
    deadlineAt: EXPIRY,
  };
  await journal.define(definition, surfaceContext);
  await journal.trigger({
    jobRunId: "job-run-s6",
    scheduledFor: NOW,
    context: { ...surfaceContext, requestId: "trigger-job-s6" },
    source: "user",
  });
  const unsigned = createJobUnsignedEnvelope({
    signer: authority.signer,
    executorId: authority.executorId,
    permissionSnapshot,
  });
  const plan: JobAssignmentPlan = {
    taskId: "task-s6",
    jobRunId: "job-run-s6",
    anchorEpoch: 1,
    assignmentId: unsigned.assignmentId,
    executorId: unsigned.executorId,
    manifest: unsigned.manifest,
    materialize: () => unsigned,
  };
  const dispatch = await journal.assign(plan);
  const authorization = () => ({
    capability: dispatch.envelope.capabilities[0]!,
    activation: dispatch.activation,
  });

  let executorPort: ConversationAssignmentLedger | MeshRunExecutorPort = ledger;
  let ownerSubmission: JobJournal | MeshRunSubmissionPort = journal;
  let mesh: MeshRuntimeAssembly | undefined;
  let ackInterrupted = false;
  if (topology === "remote") {
    const ownerHandlers = new Map<string, ServiceHandler>();
    const executorHandlers = new Map<string, ServiceHandler>();
    const ownerReceiver = new FileResumableArtifactReceiver(
      authority.artifacts,
      path.join(home, "job-owner-partials"),
      { maxArtifactBytes: 512 * 1024 * 1024 },
    );
    const executorReceiver = new FileResumableArtifactReceiver(
      authority.artifacts,
      path.join(home, "job-executor-partials"),
      { maxArtifactBytes: 512 * 1024 * 1024 },
    );
    const streamRequests = new Map<string, number>();
    const ownerToExecutor = serviceClient(
      executorHandlers,
      authority.deviceId,
      streamRequests,
      (serviceId, payload) => {
        if (
          !interactive ||
          ackInterrupted ||
          serviceId !== ASSIGNMENT_STREAM_SERVICE
        ) {
          return false;
        }
        const request = JSON.parse(new TextDecoder().decode(payload)) as {
          readonly t?: unknown;
        };
        if (request.t !== "ack") return false;
        ackInterrupted = true;
        return true;
      },
    );
    const executorToOwner = serviceClient(
      ownerHandlers,
      "device:s6-job-remote",
    );
    const artifactHandler = createAssignmentArtifactServiceHandler({
      artifacts: authority.artifacts,
      receiver: executorReceiver,
      verifier: authority.verifier,
      authorize: () => undefined,
      clock: () => Date.parse(NOW),
    });
    ownerHandlers.set(ASSIGNMENT_ARTIFACT_SERVICE, artifactHandler);
    executorHandlers.set(ASSIGNMENT_ARTIFACT_SERVICE, artifactHandler);
    executorHandlers.set(
      RUN_EXECUTOR_SERVICE,
      createRunExecutorMeshServiceHandler({
        port: ledger,
        guard: ledger,
        artifacts: authority.artifacts,
        verifier: authority.verifier,
        signer: authority.signer,
        localDeviceId: "device:s6-job-remote",
        artifactAuthorizationFor: authorization,
        authorizePeer: (deviceId) => deviceId === authority.deviceId,
        clock: () => Date.parse(NOW),
      }),
    );
    ownerHandlers.set(
      RUN_SUBMISSION_SERVICE,
      createRunSubmissionMeshServiceHandler({
        port: journal,
        guard: journal,
        artifacts: authority.artifacts,
        executorIdForPeer: () => authority.executorId,
      }),
    );
    executorHandlers.set(
      ASSIGNMENT_STREAM_SERVICE,
      createAssignmentStreamServiceHandler({
        spool: dataPlane.spool,
        authorize: createDataPlaneAssignmentStreamAuthorizer({
          tickets: dataPlane.tickets,
          surfacePrincipalFor: () => "surface:device:owner",
          ownerMayPresentSurfaceTicket: () => true,
          authorizeOwnerRelay: async (request) => {
            await ledger.authorizeOwnerRelay({
              assignmentId: request.assignmentId,
              consumer: request.consumer as Extract<
                typeof request.consumer,
                { readonly kind: "owner-relay" }
              >,
              ownerDeviceId: request.connection.peer.deviceId,
            });
            return {};
          },
        }),
      }),
    );
    executorPort = new MeshRunExecutorPort({
      client: ownerToExecutor,
      artifacts: authority.artifacts,
      receiver: ownerReceiver,
      verifier: authority.verifier,
      signer: authority.signer,
      localDeviceId: authority.deviceId,
      peerDeviceId: "device:s6-job-remote",
      authorizationFor: authorization,
      clock: () => Date.parse(NOW),
    });
    ownerSubmission = new MeshRunSubmissionPort({
      client: executorToOwner,
      artifacts: authority.artifacts,
      receiver: executorReceiver,
      signer: authority.signer,
      localDeviceId: "device:s6-job-remote",
      peerDeviceId: authority.deviceId,
      authorizationFor: authorization,
      clock: () => Date.parse(NOW),
    });
    mesh = {
      dataPlaneForExecutor(candidate: string) {
        if (candidate !== authority.executorId) {
          throw new Error("S6 job selected another executor");
        }
        return {
          stream: new AssignmentStreamMeshClient(ownerToExecutor),
          tickets: new DataPlaneTicketMeshClient(ownerToExecutor),
        };
      },
    } as MeshRuntimeAssembly;
  }

  const assignmentSubmission = new InProcessAssignmentSubmission({
    ledger,
    owner: ownerSubmission,
  });
  const dispatcher = new InProcessJobDispatcher({
    enabled: true,
    journal,
    executor: executorPort,
    contexts: jobDispatchContexts({
      signer: authority.signer,
      ownerDeviceId: authority.deviceId,
      envelope: unsigned,
    }),
    cancellationSubmission: {
      submitCancellation: (assignmentId) =>
        assignmentSubmission.submitCancellation(
          assignmentId,
          submissionContext(dispatch.envelope.capabilities[0]!),
        ),
    },
    bundleSubmission: {
      submitSealedBundle: (assignmentId) =>
        assignmentSubmission.submitSealedBundle(
          assignmentId,
          submissionContext(dispatch.envelope.capabilities[0]!),
        ),
    },
  });
  await dispatcher.dispatchPending();
  const context = submissionContext(dispatch.envelope.capabilities[0]!);
  await assignmentSubmission.startAndReport(unsigned.assignmentId, context);
  const writer = await dataPlane.createStream({
    assignmentId: unsigned.assignmentId,
    ref: dispatch.activation.ref,
  });

  const interactions = new DurableConversationInteractionObserver();
  const protocol = new ConversationProtocolRuntime({
    authority,
    manager: () => {
      throw new Error("Job-only S6 scenario has no conversation manager");
    },
    interactions,
  });
  let challenge: ChannelChallengeMessage | undefined;
  let sendAttempts = 0;
  const sendChallenge = vi.fn(async (input) => {
    sendAttempts += 1;
    if (topology === "remote" && interactive && sendAttempts === 1) {
      return {
        success: false as const,
        retryable: true,
        error: "injected channel send interruption",
      };
    }
    challenge = input;
    return { success: true as const, messageId: "job-message-s6" };
  });
  const channels = fakeChannels(sendChallenge);
  const jobStatus = new JobStatusDirectory();
  const composition = createLosslessDataPlaneComposition({
    authority:
      topology === "local"
        ? authority
        : authorityWithExecutorId(authority, "executor:s6-owner"),
    ...(topology === "local" ? { local: dataPlane } : {}),
    mesh: () => mesh,
    interactions,
    protocol,
    channels: () => channels,
    jobStatus,
  });
  composition.runtime.bindChannels(channels);

  const interactionRequestId = "interaction-job-s6";
  const display = { title: "Approve?", lines: ["job work"] };
  await ledger.requestInteraction(unsigned.assignmentId, {
    requestId: interactionRequestId,
    toolName: "bash",
    display,
    issuedAt: NOW,
    ttlMs: 60_000,
    expiresAt: "2026-07-28T00:01:00.000Z",
  });
  await writer.appendInteractionRequested({
    requestId: interactionRequestId,
    toolName: "bash",
    display,
    issuedAt: NOW,
    ttlMs: 60_000,
    expiresAt: "2026-07-28T00:01:00.000Z",
  });
  let preparedCursorInterrupted = false;
  if (topology === "remote" && interactive) {
    const adopt = journal.adoptChannelRelayFrame.bind(journal);
    vi.spyOn(journal, "adoptChannelRelayFrame")
      .mockImplementationOnce(async () => {
        preparedCursorInterrupted = true;
        throw new Error("injected prepared/cursor interruption");
      })
      .mockImplementation((input) => adopt(input));
  }
  const resolveNoInteractiveSurface = vi.fn(async () => {
    await writer.appendInteractionFinished({
      requestId: interactionRequestId,
      outcome: "denied",
    });
    await assignmentSubmission.finishAndMirror(
      unsigned.assignmentId,
      interactionRequestId,
      {
        t: "auto-resolved",
        decision: "denied",
        reason: "no-interactive-surface",
      },
      context,
    );
  });
  const deliverGrant = vi.fn(async (grant) => {
    const preparation = await ledger.prepareInteractionAnswerFromChannel({
      assignmentId: unsigned.assignmentId,
      requestId: interactionRequestId,
      grant,
      at: NOW,
    });
    if (preparation.kind === "authorized") {
      await writer.appendInteractionFinished({
        requestId: interactionRequestId,
        outcome: preparation.outcome.decision.allowed ? "allowed" : "denied",
      });
      await assignmentSubmission.finishAndMirror(
        unsigned.assignmentId,
        interactionRequestId,
        preparation.outcome,
        context,
      );
    }
  });
  const relay = await composition.coordinator.registerJobRelay({
    assignmentId: unsigned.assignmentId,
    ref: dispatch.activation.ref as Extract<
      ExecutionRef,
      { readonly execution: "job" }
    >,
    executorId: authority.executorId,
    controlLeaseId: dispatch.envelope.controlLease.controlLeaseId,
    journal,
    deliverGrant,
    resolveNoInteractiveSurface,
  });
  if (interactive) {
    await vi.waitFor(() =>
      expect(sendChallenge).toHaveBeenCalledTimes(
        topology === "remote" ? 2 : 1,
      ),
    );
    const current = challenge;
    if (!current) throw new Error("S6 job scenario did not emit a challenge");
    if (probeCrossDomain) {
      if (current.token.ref.execution !== "job") {
        throw new Error("S6 job scenario emitted a conversation challenge");
      }
      const { signature: _signature, ...unsignedForeignToken } = current.token;
      await expect(
        composition.coordinator.handleChallengeAction({
          token: createSignedChannelChallengeToken(
            {
              ...unsignedForeignToken,
              assignmentId: `${unsigned.assignmentId}:foreign`,
            },
            authority.signer,
          ),
          responder,
          decision: { allowed: true },
        }),
      ).rejects.toThrow(/active job obligation/u);
      expect(deliverGrant).not.toHaveBeenCalled();
    }
    await composition.coordinator.handleChallengeAction({
      token: current.token,
      responder,
      decision: { allowed: true },
    });
    expect(deliverGrant).toHaveBeenCalledOnce();
  } else {
    await vi.waitFor(() =>
      expect(resolveNoInteractiveSurface).toHaveBeenCalledOnce(),
    );
    expect(sendChallenge).not.toHaveBeenCalled();
  }

  const streamFinal = await writer.final();
  const bundle = await ledger.sealJobBundle(unsigned.assignmentId, {
    fence: unsigned.work.fence,
    outcome: { status: "completed", summary: "scheduled work completed" },
    contentAssets: [],
    streamFinal,
    usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
    usageFinal: { reportDigest: DIGEST, upToUsageSeq: 0 },
  });
  const committed = await ownerSubmission.submitBundle(bundle, context);
  expect(committed.committed).toBe(true);
  const statusPage = await jobStatus.statusHistory([{
    taskId: "task-s6",
    jobRunId: "job-run-s6",
    afterStatusRevision: 0,
  }]);
  const statuses = statusPage.notices;
  const deliveries = await authority.authority.list();
  expect(statuses.length).toBeGreaterThan(0);
  expect(statuses.every(
    (notice) =>
      notice.ref.taskId === "task-s6" &&
      notice.ref.jobRunId === "job-run-s6",
  )).toBe(true);
  expect(statuses.map((notice) => notice.statusRevision)).toEqual(
    statuses.map((_, index) => index + 1),
  );
  expect(statusPage.next).toEqual([{
    taskId: "task-s6",
    jobRunId: "job-run-s6",
    afterStatusRevision: statuses.length,
  }]);
  expect(
    deliveries.filter(
      (entry) =>
        entry.keyBody.kind === "job-result-delivery" &&
        entry.keyBody.taskId === "task-s6" &&
        entry.keyBody.jobRunId === "job-run-s6" &&
        entry.state === "queued",
    ),
  ).toHaveLength(1);
  if (topology === "remote" && interactive) {
    expect(preparedCursorInterrupted).toBe(true);
    expect(ackInterrupted).toBe(true);
    expect(sendChallenge).toHaveBeenCalledTimes(2);
  }

  await relay.close();
  await composition.close();
  await dataPlane.close();
  authority.stopStorageMaintenance();
  return { statuses, deliveries };
}

describe("S6 production-composition conformance", () => {
  it.each([
    ["first-party", "local"],
    ["first-party", "remote"],
    ["channel", "local"],
    ["channel", "remote"],
  ] as const)(
    "closes one real %s conversation through the %s executor topology",
    async (surface, topology) => {
      const result = await runConversationScenario(surface, topology);
      expect(result.assignmentId).toMatch(/^assignment:/u);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it.each(["local", "remote"] as const)(
    "closes one real job status/result/delivery chain through the %s executor topology",
    async (topology) => {
      await runJobScenario(topology, true);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "auto-resolves a job without a legal channel responder",
    async () => {
      await runJobScenario("local", false);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "rejects a valid cross-domain callback while another job obligation is active",
    async () => {
      await runJobScenario("local", true, true);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );
});
