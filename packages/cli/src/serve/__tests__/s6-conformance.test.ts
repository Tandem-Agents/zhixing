import path from "node:path";
import {
  ConfirmationBroker,
  type AgentYield,
  type ChannelChallengeMessage,
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
  createAuthorityPrincipalMethodGuard,
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
  ExecutorResourceGovernor,
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
  RESOURCE_USAGE_SERVICE,
  RUN_EXECUTOR_SERVICE,
  RUN_SUBMISSION_SERVICE,
  MeshResourceUsageIntake,
  MeshRunExecutorPort,
  MeshRunSubmissionPort,
  createAssignmentArtifactServiceHandler,
  createResourceUsageMeshServiceHandler,
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
import { ASSIGNMENT_RECORD_V2_WRITES_ENABLED } from "../conversation-executor-ledger.js";
import {
  ConversationProtocolRuntime,
  DurableConversationInteractionObserver,
} from "../conversation-protocol-runtime.js";
import {
  createConversationExecutorHostBoundary,
  type ConversationExecutorTopologyDirectory,
} from "../conversation-executor-dispatch.js";
import { anchorConversationOwnerRuntime } from "../conversation-owner-runtime.js";
import {
  DATA_PLANE_TICKET_SERVICE,
  DataPlaneTicketMeshClient,
  createDataPlaneTicketServiceHandler,
} from "../data-plane-ticket-mesh.js";
import type { JobInteractionAnswerPort } from "../durable-job-interactions.js";
import { enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import { ExecutorDataPlaneRuntime } from "../executor-data-plane-runtime.js";
import { loadOrCreateDeviceKey } from "../mesh-device-key.js";
import type { JobRuntimePort } from "../job-assignment-worker.js";
import { ExecutorJobOwnerAssembly } from "../executor-job-owner.js";
import {
  JOB_INTERACTION_SERVICE,
  JobInteractionMeshClient,
  createJobInteractionServiceHandler,
} from "../job-interaction-mesh.js";
import {
  ExecutionStatusHub,
  FirstPartyFinalitySession,
} from "../first-party-finality-session.js";
import { JobStatusDirectory } from "../job-status-directory.js";
import { createLosslessDataPlaneComposition } from "../lossless-data-plane-composition.js";
import type { ChannelChallengeDeliveryPort } from "../lossless-data-plane-runtime.js";
import type { MeshRuntimeAssembly } from "../mesh-runtime-assembly.js";
import { createOwnerControlAuthorizer } from "../owner-control-authorizer.js";

// 场景基准时间取真实当前时刻,且每个场景开跑时刷新:授权物的接受方按
// 真实(含单调)时钟校验剩余时效,控制租约仅 60 秒——晚启动的用例若沿用
// 模块加载时刻,租约在开跑前就已耗尽。
let NOW = new Date().toISOString();
let EXPIRY = new Date(Date.parse(NOW) + 2 * 60 * 60 * 1000).toISOString();
// 控制租约受 60 秒协议上限约束,与其余授权物的两小时窗口分开派生。
let CONTROL_LEASE_EXPIRY = new Date(Date.parse(NOW) + 60_000).toISOString();

function refreshScenarioClock(): void {
  NOW = new Date().toISOString();
  EXPIRY = new Date(Date.parse(NOW) + 2 * 60 * 60 * 1000).toISOString();
  CONTROL_LEASE_EXPIRY = new Date(Date.parse(NOW) + 60_000).toISOString();
}
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

function fakeChannels(sendChallenge: ReturnType<typeof vi.fn>): ChannelChallengeDeliveryPort {
  return {
    supports: (channelId) => channelId === "feishu",
    sendChallenge,
  };
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
  } else {
    // 渠道场景:executor 侧存在等待远端裁决的交互面,请求保持挂起,
    // 由渠道 grant 经耐久答复端口解决;无订阅者会触发 fail-closed 兜底。
    broker.onRequest(() => {});
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
      () => new Date().toISOString(),
    ),
    snapshotFor: input.snapshotFor,
    permissionSnapshotFor: input.permissionSnapshotFor,
    runtimeBindingGuard: () => undefined,
    dataPlaneTickets: input.tickets,
    resources: input.authority.executorResourceGovernor,
    assignmentRecordV2Writes: ASSIGNMENT_RECORD_V2_WRITES_ENABLED,
    clock: () => new Date().toISOString(),
  });
}

interface RemoteExecutorHarness {
  readonly authorityView: AuthorityRuntimeStack;
  readonly dataPlane: ExecutorDataPlaneRuntime;
  readonly ledger: ConversationAssignmentLedger;
  readonly directory: ConversationExecutorTopologyDirectory;
  readonly mesh: MeshRuntimeAssembly;
  /** 远端 executor worker 的失败出口:静默会让 owner 侧只表现为挂起。 */
  readonly workerErrors: readonly Error[];
  close(): Promise<void>;
}

async function createRemoteConversationExecutor(input: {
  readonly home: string;
  readonly authority: AuthorityRuntimeStack;
  readonly protocol: ConversationProtocolRuntime;
  readonly runtimeFactory: RuntimeFactory;
  readonly interactions: DurableConversationInteractionObserver;
  readonly executorKey: Awaited<ReturnType<typeof loadOrCreateDeviceKey>>;
}): Promise<RemoteExecutorHarness> {
  const executorId = "executor:s6-remote";
  // 远端 executor 持自己的设备钥匙:artifact 传输授权等协议物要求
  // 签名者即来源设备,借 owner 钥匙署远端设备名无法通过校验。
  const executorKey = input.executorKey;
  const executorDeviceId = executorKey.deviceId;
  const executorRoot = path.join(input.home, "remote-executor");
  const artifacts = new FileArtifactStore(path.join(executorRoot, "artifacts"));
  const log = new FileAuthorityCommitLog(
    path.join(executorRoot, "authority"),
    artifacts,
    { clock: () => new Date().toISOString() },
  );
  const permissions = new Map<string, TrustRuleSnapshot>();
  let snapshot = executorSnapshot(executorId, executorKey, 1);
  // 远端 executor 的资源治理必须以自己的身份与账本运行——资源根的
  // audience 绑定 executorId,复用 owner 实例会被 audience 校验拒绝。
  const remoteResourceGovernor = new ExecutorResourceGovernor({
    log,
    signer: executorKey,
    verifier: input.authority.verifier,
    guard: createAuthorityPrincipalMethodGuard({
      "resource-governor": [
        "reservation.enqueueRoot",
        "reservation.prepareAssignmentRoot",
        "reservation.prepareSystemJobRoot",
        "reservation.acquireRoot",
        "reservation.acquireChild",
        "reservation.reserveUsage",
        "reservation.consume",
        "reservation.settle",
        "reservation.release",
      ],
    }),
    executorId,
    localDomainId: `local:${executorDeviceId}`,
    localGovernorEpoch: 1,
    clock: () => new Date().toISOString(),
  });
  // 惰性覆盖:owner stack 上被禁用的 getter(如本地 executorLog)不得
  // 被浅展开立即求值,远端替换面按属性名代理。
  const executorOverrides: Record<string, unknown> = {
    executorId,
    signer: executorKey,
    executorLog: log,
    artifacts,
    executorResourceGovernor: remoteResourceGovernor,
    executorCapabilities: {
      snapshotFor: (candidate: string) =>
        candidate === executorId ? snapshot : undefined,
    },
    permissionSnapshotFor: (digest: string) => permissions.get(digest),
  };
  const executorAuthority = new Proxy(input.authority, {
    get(target, property, receiver) {
      if (typeof property === "string" && property in executorOverrides) {
        return executorOverrides[property];
      }
      return Reflect.get(target, property, receiver);
    },
  }) as AuthorityRuntimeStack;
  const dataPlane = new ExecutorDataPlaneRuntime({
    zhixingHome: executorRoot,
    authority: executorAuthority,
    module: {
      AssignmentStreamSpool,
      AssignmentStreamWriter,
      DataPlaneTicketRegistry,
    },
    clock: () => new Date().toISOString(),
  });
  const ledger = createExecutorLedger({
    authority: executorAuthority,
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
      clock: () => Date.now(),
    }),
  );
  executorHandlers.set(
    ASSIGNMENT_ARTIFACT_SERVICE,
    createAssignmentArtifactServiceHandler({
      artifacts,
      receiver: executorReceiver,
      verifier: input.authority.verifier,
      authorize: () => undefined,
      clock: () => Date.now(),
    }),
  );

  const submission = new MeshRunSubmissionPort({
    client: executorToOwner,
    artifacts,
    receiver: executorReceiver,
    signer: executorKey,
    localDeviceId: executorDeviceId,
    peerDeviceId: input.authority.deviceId,
    authorizationFor: authorizationForExecutor,
    clock: () => Date.now(),
  });
  ownerHandlers.set(
    RESOURCE_USAGE_SERVICE,
    createResourceUsageMeshServiceHandler({
      intake: input.authority.resourceGovernor,
      reporterIdForPeer: (deviceId) =>
        deviceId === executorDeviceId ? executorId : undefined,
    }),
  );
  const usageIntake = new MeshResourceUsageIntake({ client: executorToOwner });
  const workerErrors: Error[] = [];
  const worker = new ConversationAssignmentWorker({
    ledger,
    runtimeFactory: input.runtimeFactory,
    artifacts,
    submissionFor: () => submission,
    finalizeUsage: ({ assignmentId }) =>
      remoteResourceGovernor.flushAssignment(
        assignmentId,
        usageIntake,
        (report) => ({
          principal: { kind: "usage-reporter", executorId: report.reporterId },
          requestId: `usage-report:${report.digest}`,
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ),
    InProcessAssignmentSubmission,
    interactions: input.interactions,
    createStream: (stream) => dataPlane.createStream(stream),
    onError: (_assignmentId, error) => workerErrors.push(error),
  });
  executorHandlers.set(
    RUN_EXECUTOR_SERVICE,
    createRunExecutorMeshServiceHandler({
      port: ledger,
      guard: ledger,
      artifacts,
      verifier: input.authority.verifier,
      signer: executorKey,
      localDeviceId: executorDeviceId,
      artifactAuthorizationFor: authorizationForExecutor,
      authorizePeer: (deviceId) => deviceId === input.authority.deviceId,
      onDispatchAccepted: (envelope) => worker.accept(envelope),
      clock: () => Date.now(),
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
          await dataPlane.authorizeOwnerRelayConsumer({
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
    clock: () => Date.now(),
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
  const directory: ConversationExecutorTopologyDirectory = {
    async candidates() {
      return [{
        executorId,
        executor,
        async synchronizePermission(permission) {
          permissions.set(permission.digest, permission);
          snapshot = executorSnapshot(
            executorId,
            executorKey,
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
                executorKey,
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
    workerErrors,
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
  refreshScenarioClock();
  const home = await createTempDir(`s6-${surface}-${topology}`);
  // 远端 executor 的设备钥匙先于 owner stack 生成:协议物要求签名者即
  // 来源设备,owner 侧的设备授权面也要认这把钥匙。
  const remoteExecutorKey =
    topology === "remote"
      ? await loadOrCreateDeviceKey(new MemorySecretStore())
      : undefined;
  const authority = await setupAuthorityRuntime({
    zhixingHome: home,
    secretStore: new MemorySecretStore(),
    executorReadiness,
    enableLocalExecutor: topology === "local",
    ...(remoteExecutorKey
      ? {
          authorizedDeviceIds: [remoteExecutorKey.deviceId],
          trustedIdentities: [
            enrollDeviceIdentity(remoteExecutorKey, {
              displayName: "s6-remote-executor",
              platform: "linux",
              enrolledAt: NOW,
            }),
          ],
        }
      : {}),
    clock: () => new Date().toISOString(),
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
      clock: () => new Date().toISOString(),
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
  const executorBoundary = createConversationExecutorHostBoundary({
    authority: anchorConversationOwnerRuntime(authority),
    clock: () => new Date().toISOString(),
    ...(topology === "local"
      ? {
          local: {
            ConversationAssignmentLedger,
            InProcessAssignmentSubmission,
            dataPlaneTickets: localDataPlane!.tickets,
            createStream: (stream: {
              readonly assignmentId: string;
              readonly ref: ExecutionRef;
            }) => localDataPlane!.createStream(stream),
            runtimeFactory,
          },
        }
      : {}),
  });
  protocol = new ConversationProtocolRuntime({
    authority,
    executorDispatch: executorBoundary.application,
    ...(executorBoundary.staging
      ? { assignmentStaging: executorBoundary.staging }
      : {}),
    manager: () => manager,
    interactions,
    clock: () => new Date().toISOString(),
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
    localDataPlane!.bindLedger(executorBoundary.localLedger!);
    await localDataPlane!.start();
  } else {
    remote = await createRemoteConversationExecutor({
      home,
      authority,
      protocol,
      runtimeFactory,
      interactions,
      executorKey: remoteExecutorKey!,
    });
    executorBoundary.topology.bindDirectory(remote.directory);
  }

  let challenge: ChannelChallengeMessage | undefined;
  const sendChallenge = vi.fn(async (input) => {
    challenge = input;
    return { success: true as const, messageId: "message-s6" };
  });
  const channels = fakeChannels(sendChallenge);
  const conversationBackgroundErrors: Error[] = [];
  const composition = createLosslessDataPlaneComposition({
    authority,
    ...(localDataPlane ? { local: localDataPlane } : {}),
    mesh: () => remote?.mesh,
    interactions,
    protocol,
    channelChallenges: () => channels,
    jobStatus,
    onDataPlaneError: (error) => conversationBackgroundErrors.push(error),
    onCoordinatorError: (error) => conversationBackgroundErrors.push(error),
  });
  composition.runtime.bindChannelChallenges(channels);

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
    await vi.waitFor(
      () => {
        if (conversationBackgroundErrors.length > 0) {
          throw new AggregateError(
            conversationBackgroundErrors,
            `S6 conversation background failures: ${conversationBackgroundErrors
              .slice(0, 3)
              .map((error) => `${error.name}: ${error.message}`)
              .join("; ")}`,
          );
        }
        expect(sendChallenge).toHaveBeenCalledOnce();
      },
      { timeout: 30_000 },
    );
    const current = challenge;
    if (!current) throw new Error("S6 channel scenario did not emit a challenge");
    await composition.coordinator.handleChallengeAction({
      token: current.token,
      responder,
      decision: { allowed: true },
    });
  }
  const settled = await Promise.race([
    turn,
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        reject(
          new Error(
            `Conversation turn did not settle; background=${JSON.stringify(
              conversationBackgroundErrors.slice(0, 2).map((error) =>
                error instanceof AggregateError
                  ? `${error.name}: [${error.errors
                      .map((entry) =>
                        entry instanceof Error
                          ? `${entry.name}: ${entry.message} <= ${
                              entry.cause instanceof Error
                                ? `${entry.cause.stack}`
                                : String(entry.cause)
                            }`
                          : String(entry),
                      )
                      .join(" | ")}]`
                  : `${error.name}: ${error.message}`,
              ),
            )}; remoteWorker=${JSON.stringify(
              (remote?.workerErrors ?? []).map(
                (error) => `${error.name}: ${error.message}`,
              ),
            )}; statuses=${JSON.stringify(statuses)}; finals=${JSON.stringify(
              finals,
            )}; frameKinds=${JSON.stringify(
              firstPartyFrames.map((frame) => frame.payload.kind),
            )}`,
          ),
        );
      }, 25_000).unref(),
    ),
  ]);
  if (settled.kind === "error") {
    if (settled.error instanceof AggregateError) {
      throw new Error(
        `${settled.error.message}: [${settled.error.errors
          .map((entry) => (entry instanceof Error ? entry.message : String(entry)))
          .join(" | ")}]`,
        { cause: settled.error },
      );
    }
    throw settled.error;
  }
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
  await authority.stopStorageMaintenance();
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
  readonly executorSnapshot: ExecutorCapabilitySnapshot;
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
      ...input.executorSnapshot.inventory.configVersions,
      ...input.executorSnapshot.inventory.assetVersions,
      permissionSnapshotVersion: input.permissionSnapshot.snapshotVersion,
    },
    protocolVersion: input.executorSnapshot.descriptor.protocolVersion,
    tools: [...input.executorSnapshot.descriptor.tools],
    mcpServers: [...input.executorSnapshot.descriptor.mcpServers],
    environment: {},
    credentialBindings: input.executorSnapshot.descriptor.credentialBindings.map(
      (binding) => ({ ...binding }),
    ),
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
    expiry: CONTROL_LEASE_EXPIRY,
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
      "global.read",
      "global.mutate",
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
        // grant 的时效必须落在其控制租约窗口内。
        expiry: input.envelope.controlLease.expiry,
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
        deadlineAt: input.envelope.controlLease.expiry,
      };
    },
  };
}

async function runJobScenario(
  topology: ExecutionTopology,
  interactive: boolean,
  probeCrossDomain = false,
) {
  refreshScenarioClock();
  const home = await createTempDir(`s6-job-${topology}-${interactive}`);
  const authority = await setupAuthorityRuntime({
    zhixingHome: home,
    secretStore: new MemorySecretStore(),
    executorReadiness,
    clock: () => new Date().toISOString(),
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
    clock: () => new Date().toISOString(),
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
    clock: () => new Date().toISOString(),
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
    executorSnapshot: snapshot,
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

  // executor-owned job 执行装配:worker 自持真实交互协调器;fake 只在
  // 外部 job runtime 边界(可控 agent 脚本),与 conversation 场景同构。
  const jobRuntime: JobRuntimePort = {
    create: async ({ confirmationBroker: broker }) => {
      // executor 侧交互面存在但只等待远端裁决:渠道 grant 或无应答
      // fail-closed 均须经耐久答复端口进入,不允许 broker 本地兜底。
      broker.onRequest(() => {});
      return {
        async *run(instruction) {
          const createdAt = Date.parse(NOW);
          await broker.requestConfirmation({
            id: "interaction-job-s6",
            tool: "bash",
            toolInput: { command: instruction.prompt },
            workingDirectory: home,
            display: {
              title: "Approve?",
              body: { kind: "generic", summary: "job work" },
              cwd: home,
            },
            options: [{ kind: "allow-once", label: "Allow" }],
            sessionType: "interactive",
            contextId: { kind: "main" },
            createdAt,
            expiresAt: createdAt + 60_000,
          });
          yield { type: "text_delta", text: "done" } as AgentYield;
          return {
            status: "completed" as const,
            summary: "scheduled work completed",
            contentAssets: [],
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
        async dispose() {},
      };
    },
  };

  let ownerSubmission: JobJournal | MeshRunSubmissionPort = journal;
  let executorPort: ConversationAssignmentLedger | MeshRunExecutorPort = ledger;
  let mesh: MeshRuntimeAssembly | undefined;
  let ackInterrupted = false;
  const workerErrors: Error[] = [];
  const jobOwnerAssembly = new ExecutorJobOwnerAssembly({
    ledger,
    runtime: jobRuntime,
    submissionFor: () => ownerSubmission,
    finalizeUsage: async () => ({
      reportDigest: DIGEST,
      upToUsageSeq: 0,
    }),
    InProcessAssignmentSubmission,
    createStream: (stream) => dataPlane.createStream(stream),
    onError: (_assignmentId, error) => workerErrors.push(error),
  });
  await jobOwnerAssembly.start();
  const jobOwner = jobOwnerAssembly.owner;
  let answers: JobInteractionAnswerPort = jobOwner;
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
      authority.deviceId,
    );
    const artifactHandler = createAssignmentArtifactServiceHandler({
      artifacts: authority.artifacts,
      receiver: executorReceiver,
      verifier: authority.verifier,
      authorize: () => undefined,
      clock: () => Date.now(),
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
        localDeviceId: authority.deviceId,
        artifactAuthorizationFor: authorization,
        authorizePeer: (deviceId) => deviceId === authority.deviceId,
        onDispatchAccepted: (envelope) => jobOwner.accept(envelope),
        onCancelAccepted: (assignmentId) =>
          jobOwner.cancelAccepted(assignmentId),
        clock: () => Date.now(),
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
            await dataPlane.authorizeOwnerRelayConsumer({
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
      JOB_INTERACTION_SERVICE,
      createJobInteractionServiceHandler({
        answers: jobOwner,
        verifier: authority.verifier,
        authorizeOwner: (connection) =>
          connection.peer.deviceId === authority.deviceId,
      }),
    );
    executorPort = new MeshRunExecutorPort({
      client: ownerToExecutor,
      artifacts: authority.artifacts,
      receiver: ownerReceiver,
      verifier: authority.verifier,
      signer: authority.signer,
      localDeviceId: authority.deviceId,
      peerDeviceId: authority.deviceId,
      authorizationFor: authorization,
      clock: () => Date.now(),
    });
    ownerSubmission = new MeshRunSubmissionPort({
      client: executorToOwner,
      artifacts: authority.artifacts,
      receiver: executorReceiver,
      signer: authority.signer,
      localDeviceId: authority.deviceId,
      peerDeviceId: authority.deviceId,
      authorizationFor: authorization,
      clock: () => Date.now(),
    });
    answers = new JobInteractionMeshClient(ownerToExecutor);
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

  const dispatcher = new InProcessJobDispatcher({
    enabled: true,
    journal,
    executor: executorPort,
    contexts: jobDispatchContexts({
      signer: authority.signer,
      ownerDeviceId: authority.deviceId,
      envelope: unsigned,
    }),
    ...(topology === "local"
      ? {
          onDispatchAccepted: (envelope) => jobOwner.accept(envelope),
          onCancelAccepted: (assignmentId: string) =>
            jobOwner.cancelAccepted(assignmentId),
        }
      : {}),
    cancellationSubmission: {
      submitCancellation: async () => false,
    },
    bundleSubmission: {
      submitSealedBundle: async () => {
        throw new Error("S6 job scenario does not redrive sealed bundles");
      },
    },
  });

  const interactions = new DurableConversationInteractionObserver();
  const protocol = new ConversationProtocolRuntime({
    authority,
    executorDispatch: createConversationExecutorHostBoundary({
      authority: anchorConversationOwnerRuntime(authority),
      clock: () => new Date().toISOString(),
    }).application,
    manager: () => {
      throw new Error("Job-only S6 scenario has no conversation manager");
    },
    interactions,
    clock: () => new Date().toISOString(),
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
  const backgroundErrors: Error[] = [];
  const describeError = (error: unknown, depth = 0): string =>
    error instanceof Error
      ? `${error.name}: ${error.message}${
          error.cause !== undefined && depth < 6
            ? ` <- ${describeError(error.cause, depth + 1)}`
            : ""
        }`
      : String(error);
  const composition = createLosslessDataPlaneComposition({
    authority:
      topology === "local"
        ? authority
        : authorityWithExecutorId(authority, "executor:s6-owner"),
    ...(topology === "local" ? { local: dataPlane } : {}),
    mesh: () => mesh,
    interactions,
    protocol,
    channelChallenges: () => channels,
    jobStatus,
    onDataPlaneError: (error) => backgroundErrors.push(error),
    onCoordinatorError: (error) => backgroundErrors.push(error),
  });
  composition.runtime.bindChannelChallenges(channels);

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
  // 唯一驱动面:dispatch 从生产入口进入 executor,worker 自然执行并产生
  // interaction、stream、result 与 delivery 终态。
  await dispatcher.dispatchPending();

  // job owner 的生产登记接缝:义务跟随已被 executor 接收的 assignment
  // 登记;答复半边只能是生产答复端口(进程内协调器或 mesh 客户端),
  // 测试不再手写任何 grant/无应答处理。
  const relay = await composition.coordinator.registerJobRelay({
    assignmentId: unsigned.assignmentId,
    ref: dispatch.activation.ref as Extract<
      ExecutionRef,
      { readonly execution: "job" }
    >,
    executorId: authority.executorId,
    controlLeaseId: dispatch.envelope.controlLease.controlLeaseId,
    journal,
    answers,
  });

  if (interactive) {
    await vi.waitFor(
      () => {
        // 故意注入的传输/prepared 中断是预期故障,由重驱吸收,不算失败。
        const unexpected = [...workerErrors, ...backgroundErrors].filter(
          (error) => !describeError(error).includes("injected"),
        );
        if (unexpected.length > 0) {
          throw new AggregateError(
            unexpected,
            `S6 job scenario background failures: ${unexpected
              .slice(0, 3)
              .map((error) => describeError(error))
              .join("; ")}`,
          );
        }
        expect(sendChallenge).toHaveBeenCalledTimes(
          topology === "remote" ? 2 : 1,
        );
      },
      { timeout: 30_000 },
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
    }
    await composition.coordinator.handleChallengeAction({
      token: current.token,
      responder,
      decision: { allowed: true },
    });
  } else {
    expect(sendChallenge).not.toHaveBeenCalled();
  }

  await jobOwnerAssembly.drain();
  await expect(
    ledger.interactionStreamProjectionEnabled(unsigned.assignmentId),
  ).resolves.toBe(true);
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
  if (!interactive) {
    // fail-closed 自动解决必须留下耐久痕迹且不再有开放 challenge。
    expect(await journal.pendingChannelChallenges()).toHaveLength(0);
  }
  if (topology === "remote" && interactive) {
    expect(preparedCursorInterrupted).toBe(true);
    expect(ackInterrupted).toBe(true);
    expect(sendChallenge).toHaveBeenCalledTimes(2);
  }

  await relay.close();
  await composition.close();
  await jobOwnerAssembly.close();
  await dataPlane.close();
  await authority.stopStorageMaintenance();
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
