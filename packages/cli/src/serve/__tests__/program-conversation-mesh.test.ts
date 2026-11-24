import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assistantMessage,
  extractText,
  type AgentYield,
  type Message,
  type RunResult,
} from "@zhixing-ai/core";
import {
  assertLocalConversationIdForDevice,
  isLocalConversationId,
  localConversationId,
  worksceneConversationId,
} from "@zhixing-ai/core/conversation";
import {
  PROGRAM_MAX_WAIT_SLICE_MS,
  PROGRAM_SINGLE_FRAME_MAX_BYTES,
  ProgramConversationError,
  decodeProgramBodyCursor,
  encodeProgramBodyCursor,
  encodeProgramConversationTicket,
  isExtendedConversationDiscoverRequest,
  programConversationTurnId,
  programHomeId,
} from "@zhixing-ai/core/conversation/application";
import { createSignedTrustRuleSnapshot } from "@zhixing-ai/core/protocol";
import { WORKSCENE_MANAGEMENT_LIST_QUERY } from "@zhixing-ai/core/workscene/application";
import {
  type MeshDeviceIdentity,
  type MeshFrameTransport,
  type MeshProtocolCompatibility,
} from "@zhixing-ai/mesh";
import { MeshConnectionRegistry } from "../../../../mesh/src/bootstrap.js";
import { MeshServiceRegistry } from "../../../../mesh/src/service-registry.js";
import type { CurrentTrustProjection } from "@zhixing-ai/mesh/trust-chain";
import { createSecureMeshConnection } from "../../../../mesh/src/session.js";
import { ConversationManager } from "@zhixing-ai/owner-kernel/conversation-manager";
import { createConversationAgentTurnAdmissionPort } from "@zhixing-ai/owner-kernel/conversation-agent-turn-admission";
import type { RuntimeFactory } from "@zhixing-ai/owner-kernel/types";
import { projectSessionTurn, type ProjectedSessionTurnResult } from "@zhixing-ai/rpc";
import { RpcClientError } from "@zhixing-ai/server/client";
import { createTempDir } from "@zhixing-ai/test-utils";
import {
  runConversationListCommand,
  runConversationNewCommand,
  runConversationReadCommand,
  runConversationResultCommand,
  runConversationSendCommand,
  type ConversationCommandRuntimeIO,
  type ProgramConversationClientHandle,
} from "../../commands/conversation.js";
import { RpcProgramConversationFacade } from "../../runtime/rpc-conversation-facade.js";
import { CurrentAnchorSurfaceRpcClient } from "../../runtime/surface-core-host-link.js";
import {
  createConversationCommunicationBinding,
  discoverConversations,
} from "../conversation-communication-binding.js";
import {
  createMeshConversationCommunication,
  registerConversationCommunicationMesh,
} from "../conversation-communication-mesh.js";
import { createConversationStorageInfrastructure } from "../conversation-storage-infrastructure.js";
import {
  anchorConversationOwnerRuntime,
  createConversationResourceRecoveryPort,
  type LocalConversationOwnerRuntimeStack,
} from "../conversation-owner-runtime.js";
import { DurableConversationInteractionObserver } from "../durable-conversation-interactions.js";
import type { LocalConversationOwnerPort } from "../local-conversation-owner.js";
import {
  createExecutorProgramConversationApplication,
  createHostProgramConversationApplication,
  createLocalOwnedProgramConversationHandler,
  type HostProgramConversationController,
} from "../program-conversation-host.js";
import {
  PROGRAM_CONVERSATION_MESH_SERVICE,
  ProgramConversationMeshClient,
  registerProgramConversationMeshService,
} from "../program-conversation-mesh.js";
import {
  MemorySecretStore,
  TEST_DURABLE_IO_TIMEOUT_MS,
  TEST_RUNTIME_AUTHORITY_FACTS,
  createProtocol,
  setupAuthorityRuntime,
} from "./conversation-protocol-runtime-fixture.js";

function deviceIdentity(deviceId: string): MeshDeviceIdentity {
  return {
    deviceId,
    publicKey: `public-key-${deviceId}`,
    displayName: deviceId,
    platform: "headless",
    enrolledAt: "2026-11-23T00:00:00.000Z",
  };
}

interface TransportWaiter {
  readonly resolve: (frame: Uint8Array) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
}

class MemoryTransport implements MeshFrameTransport {
  peer!: MemoryTransport;
  readonly #queue: Uint8Array[] = [];
  readonly #waiters: TransportWaiter[] = [];
  readonly closed: Promise<void>;
  readonly #resolveClosed: () => void;
  dropNextSend = false;

  constructor(
    private readonly state: { closed: boolean; endpoints: MemoryTransport[] },
  ) {
    let resolveClosed!: () => void;
    this.closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = resolveClosed;
  }

  async send(frame: Uint8Array): Promise<void> {
    if (this.state.closed) throw new Error("closed");
    if (this.dropNextSend) {
      this.dropNextSend = false;
      await this.close();
      throw new Error("simulated transport drop after write");
    }
    this.peer.deliver(frame.slice());
  }

  async receive(signal?: AbortSignal): Promise<Uint8Array> {
    if (this.state.closed) throw new Error("closed");
    const queued = this.#queue.shift();
    if (queued) return queued;
    return new Promise<Uint8Array>((resolve, reject) => {
      const waiter: TransportWaiter = {
        resolve,
        reject,
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        waiter.onAbort = () => {
          const idx = this.#waiters.indexOf(waiter);
          if (idx >= 0) this.#waiters.splice(idx, 1);
          reject(new Error("aborted"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#waiters.push(waiter);
    });
  }

  async close(): Promise<void> {
    if (this.state.closed) return;
    this.state.closed = true;
    for (const ep of this.state.endpoints) ep.finish();
  }

  deliver(frame: Uint8Array): void {
    const waiter = this.#waiters.shift();
    if (!waiter) {
      this.#queue.push(frame);
      return;
    }
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    waiter.resolve(frame);
  }

  finish(): void {
    this.#resolveClosed();
    for (const waiter of this.#waiters.splice(0)) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.reject(new Error("closed"));
    }
  }
}

async function connectInMemoryMeshPair(input: {
  readonly leftDeviceId: string;
  readonly leftServices: MeshServiceRegistry;
  readonly leftConnections: MeshConnectionRegistry;
  readonly rightDeviceId: string;
  readonly rightServices: MeshServiceRegistry;
  readonly rightConnections: MeshConnectionRegistry;
  readonly compatibility?: MeshProtocolCompatibility;
}) {
  const state = { closed: false, endpoints: [] as MemoryTransport[] };
  const leftTransport = new MemoryTransport(state);
  const rightTransport = new MemoryTransport(state);
  state.endpoints.push(leftTransport, rightTransport);
  leftTransport.peer = rightTransport;
  rightTransport.peer = leftTransport;

  const compatibility =
    input.compatibility ?? ({ mode: "read-write", protocolVersion: "1" } as const);
  const localRange =
    compatibility.mode === "read-only"
      ? ({ min: "2", max: "2" } as const)
      : ({ min: "1", max: "1" } as const);
  const peerRange = { min: "1", max: "1" } as const;

  const leftSecure = createSecureMeshConnection({
    transport: leftTransport,
    connectionId: `conn:${input.leftDeviceId}->${input.rightDeviceId}`,
    compatibility,
    localProtocolRange: localRange,
    peerProtocolRange: peerRange,
    peer: deviceIdentity(input.rightDeviceId),
  });
  const rightSecure = createSecureMeshConnection({
    transport: rightTransport,
    connectionId: `conn:${input.rightDeviceId}->${input.leftDeviceId}`,
    compatibility,
    localProtocolRange: peerRange,
    peerProtocolRange: localRange,
    peer: deviceIdentity(input.leftDeviceId),
  });

  const leftChannel = input.leftConnections.attach(leftSecure, input.leftServices);
  const rightChannel = input.rightConnections.attach(rightSecure, input.rightServices);

  return {
    leftTransport,
    rightTransport,
    disconnect: async () => {
      await Promise.all([
        input.leftConnections.disconnect(input.rightDeviceId),
        input.rightConnections.disconnect(input.leftDeviceId),
        leftChannel.close(),
        rightChannel.close(),
      ]);
    },
  };
}

function captureCliIO(
  overrides: Partial<ConversationCommandRuntimeIO> = {},
): {
  readonly io: ConversationCommandRuntimeIO;
  readonly stdoutText: string;
  readonly stderrText: string;
} {
  let out = "";
  let err = "";
  return {
    get stdoutText() {
      return out;
    },
    get stderrText() {
      return err;
    },
    io: {
      stdout: {
        write: ((chunk: string) => {
          out += String(chunk);
          return true;
        }) as NodeJS.WriteStream["write"],
      },
      stderr: {
        write: ((chunk: string, cb?: (e?: Error | null) => void) => {
          err += String(chunk);
          cb?.(null);
          return true;
        }) as NodeJS.WriteStream["write"],
      },
      ...overrides,
    },
  };
}

function surfaceHandleFor(
  surfaceClient: CurrentAnchorSurfaceRpcClient,
): () => Promise<ProgramConversationClientHandle> {
  return async () => {
    await surfaceClient.connect();
    const facade = new RpcProgramConversationFacade({
      getClient: async () => surfaceClient,
      onNotification: () => () => {},
    });
    return {
      facade,
      dispose: async () => {},
    };
  };
}

interface StandaloneExecutorHarness {
  readonly deviceId: string;
  readonly home: string;
  readonly protocol: Awaited<ReturnType<typeof createProtocol>>;
  readonly manager: ConversationManager;
  readonly ownerPort: LocalConversationOwnerPort;
  readonly setReplyResponder: (fn: (prompt: string) => Promise<string>) => void;
  readonly createLocalConversation: (
    suffix: string,
    name: string,
    lastActiveAt?: string,
  ) => Promise<string>;
  readonly deleteLocalConversation: (conversationId: string) => Promise<void>;
  readonly setAuthorityOverride: (
    conversationId: string,
    state: "current" | "fenced" | "frozen" | "importing" | undefined,
  ) => void;
  readonly observeWaitMs: number[];
  readonly observedSignals: AbortSignal[];
  readonly admittedCountFor: (conversationId: string) => number;
  readonly close: () => Promise<void>;
}

async function createStandaloneExecutorHarness(
  label: string,
): Promise<StandaloneExecutorHarness> {
  const home = await createTempDir(`mesh-exec-${label}`);
  const authority = await setupAuthorityRuntime({
    zhixingHome: home,
    secretStore: new MemorySecretStore(),
  });
  await authority.installPermissionSnapshot(
    createSignedTrustRuleSnapshot(
      { snapshotVersion: 1, rules: [], generatedAt: new Date().toISOString() },
      authority.signer,
    ),
  );
  const storage = createConversationStorageInfrastructure({
    zhixingHome: home,
    optimalMaxTokens: 32_000,
    worksceneConversationStorageRemoval: { isRemoving: () => false } as never,
  });

  const prefix8 =
    /^fp:u([A-Za-z0-9_-]{8})/u.exec(authority.deviceId)?.[1] ??
    authority.deviceId.slice(0, 8);
  let responder: (prompt: string) => Promise<string> = async (prompt) =>
    `exec(${prefix8}):${prompt}`;
  const admittedCounts = new Map<string, number>();
  const authorityOverrides = new Map<
    string,
    "current" | "fenced" | "frozen" | "importing"
  >();
  const deletedSet = new Set<string>();
  const createdMeta = new Map<
    string,
    { name: string; lastActiveAt: string }
  >();
  const observeWaitMs: number[] = [];
  const observedSignals: AbortSignal[] = [];

  const runtimeFactory: RuntimeFactory = {
    create: async (conversationId) => ({
      ...TEST_RUNTIME_AUTHORITY_FACTS,
      sessionId: conversationId,
      async *run(history: readonly Message[]): AsyncGenerator<AgentYield, RunResult> {
        const lastUser = history.at(-1)!;
        const prompt = extractText(lastUser);
        admittedCounts.set(
          conversationId,
          (admittedCounts.get(conversationId) ?? 0) + 1,
        );
        const replyText = await responder(prompt);
        const msg = assistantMessage(replyText);
        yield { type: "text_delta", text: replyText };
        return {
          agentResult: {
            reason: "completed",
            message: msg,
            usage: { inputTokens: 8, outputTokens: 12 },
          },
          runRecord: {
            timestamp: new Date().toISOString(),
            messages: [lastUser, msg],
            usage: { inputTokens: 8, outputTokens: 12 },
          },
          newMessages: [msg],
          durationMs: 1,
        };
      },
      abort: () => false,
      dispose: async () => {},
    }),
  };

  let manager!: ConversationManager;
  const executorResources = authority.executorResourceGovernor;
  const localOwner: LocalConversationOwnerRuntimeStack = {
    conversationAuthority: authority.conversationAuthority,
    domain: {
      kind: "local",
      localDomainId: authority.localDomainId,
      localOwnerEpoch: authority.localOwnerEpoch,
      localGovernorEpoch: authority.localGovernorEpoch,
    },
    ownerEpoch: authority.localOwnerEpoch,
    deviceId: authority.deviceId,
    executorId: authority.executorId,
    signer: authority.signer,
    verifier: authority.verifier,
    log: authority.executorLog,
    authorityLog: authority.executorLog,
    executorLog: authority.executorLog,
    artifacts: authority.artifacts,
    controlAdmission: authority.localControlAdmission,
    executorCapabilities: authority.executorCapabilities,
    resources: executorResources,
    executionResources: executorResources,
    assignmentResources: executorResources,
    resourceRecovery: createConversationResourceRecoveryPort({
      primary: executorResources,
      acceptedWork: executorResources,
    }),
    executionAssetCatalog: authority.executionAssetCatalog,
    storageMaintenance: authority.storageMaintenance,
    globalPublishing: false,
    anchorEpoch: authority.localOwnerEpoch,
    acceptsConversationId(cid) {
      try {
        assertLocalConversationIdForDevice(cid, authority.deviceId);
        return true;
      } catch {
        return false;
      }
    },
    permissionSnapshotFor: authority.permissionSnapshotFor,
    prepareConversationAssignment: (input) =>
      authority.prepareLocalConversationAssignment({
        conversationId: input.conversationId,
        executionProfile: input.executionProfile,
        permissionRules: input.permissionRules,
        ...(input.environment ? { environment: input.environment } : {}),
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        ...(input.allowLegacyV1FollowRole !== undefined
          ? { allowLegacyV1FollowRole: input.allowLegacyV1FollowRole }
          : {}),
      }),
    validateConversationRuntimeBinding: authority.validateConversationRuntimeBinding,
    preflightLocalConversationEnvironment:
      authority.preflightLocalConversationEnvironment,
    releaseLocalConversationEnvironmentPreflight:
      authority.releaseLocalConversationEnvironmentPreflight,
    validateLocalConversationManifest: authority.validateLocalConversationManifest,
    finalizeUsage: (assignmentId) =>
      executorResources.finalizeLocalAssignment(assignmentId),
  };
  const protocol = createProtocol({
    owner: localOwner,
    losslessDataPlane: { kind: "absent", reason: "executor-only" },
    manager: () => manager,
    interactions: new DurableConversationInteractionObserver(),
  });
  manager = new ConversationManager(runtimeFactory, undefined, {
    durableTurnExecutor: protocol,
    appendCommittedRun: async (id, record) => {
      await storage.directory.ensure(id);
      await storage.directory.touch(id);
      return { runIndex: record.runIndex, shardId: "owner-log", appended: true };
    },
    onTurnCommitted: () => {},
  });
  const admissionPort = createConversationAgentTurnAdmissionPort({ manager });
  const runListeners = new Set<
    (n: { readonly conversationId: string }) => void
  >();
  protocol.onStatus((notice) => {
    for (const fn of runListeners) {
      fn({ conversationId: notice.ref.conversationId });
    }
  });

  const ownerPort: LocalConversationOwnerPort = {
    agentTurnAdmission: admissionPort,
    sessionState: protocol.sessionState,
    communicationMessages: {
      inspect: (id, msgId) => protocol.inspectMessage(id, msgId),
      inputsOutsideHistory: (id) => protocol.messageInputsOutsideHistory(id),
      programOriginRuns: async (id, runIds) => {
        const out: string[] = [];
        for (const r of runIds) {
          if (await protocol.isProgramOriginRun(id, r)) out.push(r);
        }
        return out;
      },
    },
    listConversations: async () => [...createdMeta.keys()],
    listConversationAuthorities: async () =>
      [...createdMeta.keys()]
        .filter((id) => !deletedSet.has(id))
        .map((conversationId) => ({
          conversationId,
          authority: {
            state: authorityOverrides.get(conversationId) ?? ("current" as const),
            ownerEpoch: 1,
          },
        })),
    currentAuthority: async (conversationId) => ({
      state: authorityOverrides.get(conversationId) ?? ("current" as const),
      ownerEpoch: 1,
    }),
    conversationAdoptionStatus: async (conversationId) => {
      const base = await protocol.conversationAdoptionStatus(conversationId);
      const isDel = deletedSet.has(conversationId) || base.deleted;
      const isCreated = createdMeta.has(conversationId) || base.hasDurableIdentity;
      return {
        ...base,
        deleted: isDel,
        created: isCreated,
        hasDurableIdentity: isCreated && !isDel ? true : base.hasDurableIdentity,
      };
    },
    inspectProgramInputReceipt: (conversationId, input) =>
      protocol.inspectProgramInputReceipt(conversationId, input),
    hasOpenAdvancementSession: (conversationId) =>
      protocol.hasOpenAdvancementSession(conversationId),
    isShuttingDown: () => protocol.isShuttingDown(),
    hasIdleBlockingWork: async () => manager.hasActiveWork(),
    runtimeState: (conversationId) => ({
      active: manager.has(conversationId),
      busy: manager.getSession(conversationId)?.busy ?? false,
      observerCount: 0,
      pendingCount: manager.pendingCount(conversationId),
    }),
    recoveryPage: (req) => protocol.recoveryPage(req),
    statusHistory: (after) => protocol.statusHistory(after),
    finalHistory: async () => [],
    subscribeRunNotifications: (fn) => {
      runListeners.add(fn as never);
      return () => runListeners.delete(fn as never);
    },
    createAgentTurnExecution: (turn) => {
      let settle!: (res: ProjectedSessionTurnResult) => void;
      const outcome = new Promise<ProjectedSessionTurnResult>((r) => {
        settle = r;
      });
      return {
        outcome,
        execution: {
          cancelPending: () =>
            settle({ kind: "error", error: new Error("cancelled") }),
          execute: async ({ conversationId, turnId }) => {
            try {
              const managed = await manager.getOrCreate(conversationId);
              const res = await projectSessionTurn({
                manager,
                managed,
                input: turn.input,
                turnId,
                runOptions: {
                  source: "interactive",
                  surfacePrincipal: turn.surfacePrincipal ?? "program:local",
                  turnContext: {
                    turnId,
                    ...(turn.turnOrigin ? { turnOrigin: turn.turnOrigin } : {}),
                  },
                },
                notify: turn.notify,
              });
              settle(res);
            } finally {
              manager.setBusy(conversationId, false);
            }
          },
        },
      };
    },
  } as unknown as LocalConversationOwnerPort;

  return {
    deviceId: authority.deviceId,
    home,
    protocol,
    manager,
    ownerPort,
    setReplyResponder: (fn) => {
      responder = fn;
    },
    createLocalConversation: async (
      suffix: string,
      name: string,
      lastActiveAt = "2026-11-23T14:00:00.000Z",
    ) => {
      const id = localConversationId(authority.deviceId, suffix);
      await protocol.ensureSession(id);
      await protocol.sessionState.mutate(
        id,
        { kind: "session-meta", patch: { name } },
        {
          principal: { kind: "host", component: "test-seed" },
          requestId: `seed:${id}`,
          deadlineAt: new Date(Date.now() + 10_000).toISOString(),
        },
      );
      await storage.directory.ensure(id, { name });
      createdMeta.set(id, { name, lastActiveAt });
      return id;
    },
    deleteLocalConversation: async (conversationId: string) => {
      deletedSet.add(conversationId);
      await storage.directory.delete(conversationId).catch(() => undefined);
    },
    setAuthorityOverride: (conversationId, state) => {
      if (state === undefined) authorityOverrides.delete(conversationId);
      else authorityOverrides.set(conversationId, state);
    },
    observeWaitMs,
    observedSignals,
    admittedCountFor: (conversationId) => admittedCounts.get(conversationId) ?? 0,
    close: async () => {
      await protocol.stopRecoveryLoop();
      await manager.disposeAll();
      await authority.stopStorageMaintenance();
    },
  };
}

describe("Unit 2: Multi-device conversation.program Mesh coordination & pure surface/executor closure", () => {
  it(
    "enforces strict entry/owned Mesh authorization, CurrentAnchorSurfaceRpcClient narrow switch, H -> A -> O full loop, outer <1MiB budget, >1MiB paging, >30s deducted slices, SIGINT propagation, and pure executor offline autonomy",
    async () => {
      const homeH = await createTempDir("mesh-surface-h");
      const homeOther = await createTempDir("mesh-surface-other");
      const homeA = await createTempDir("mesh-anchor-a");

      const authorityA = await setupAuthorityRuntime({
        zhixingHome: homeA,
        secretStore: new MemorySecretStore(),
        deviceId: "11111111-aaaa-4111-8111-111111111111",
      });
      await authorityA.installPermissionSnapshot(
        createSignedTrustRuleSnapshot(
          { snapshotVersion: 1, rules: [], generatedAt: new Date().toISOString() },
          authorityA.signer,
        ),
      );
      const storageA = createConversationStorageInfrastructure({
        zhixingHome: homeA,
        optimalMaxTokens: 32_000,
        worksceneConversationStorageRemoval: { isRemoving: () => false } as never,
      });

      const execO = await createStandaloneExecutorHarness("exec-o");
      const deviceH = "33333333-cccc-4333-8333-333333333333";

      let anchorResponder: (prompt: string) => Promise<string> = async (p) =>
        `anchor:${p}`;
      const adoptedIdsOnA = new Set<string>();
      const runtimeFactoryA: RuntimeFactory = {
        create: async (id) => ({
          ...TEST_RUNTIME_AUTHORITY_FACTS,
          sessionId: id,
          async *run(history: readonly Message[]): AsyncGenerator<AgentYield, RunResult> {
            const lastUser = history.at(-1)!;
            const reply = await anchorResponder(extractText(lastUser));
            const msg = assistantMessage(reply);
            yield { type: "text_delta", text: reply };
            return {
              agentResult: {
                reason: "completed",
                message: msg,
                usage: { inputTokens: 5, outputTokens: 10 },
              },
              runRecord: {
                timestamp: new Date().toISOString(),
                messages: [lastUser, msg],
                usage: { inputTokens: 5, outputTokens: 10 },
              },
              newMessages: [msg],
              durationMs: 1,
            };
          },
          abort: () => false,
          dispose: async () => {},
        }),
      };

      let managerA!: ConversationManager;
      const protocolA = createProtocol({
        owner: {
          ...anchorConversationOwnerRuntime(authorityA),
          acceptsConversationId: (cid) =>
            !isLocalConversationId(cid) || adoptedIdsOnA.has(cid),
        },
        manager: () => managerA,
        interactions: new DurableConversationInteractionObserver(),
      });
      managerA = new ConversationManager(runtimeFactoryA, undefined, {
        durableTurnExecutor: protocolA,
        appendCommittedRun: async (id, record) => {
          await storageA.directory.ensure(id);
          await storageA.directory.touch(id);
          return { runIndex: record.runIndex, shardId: "owner-log", appended: true };
        },
        onTurnCommitted: () => {},
      });

      const trust: CurrentTrustProjection = {
        homeId: "home-mesh-test",
        trustEpoch: 1,
        anchorEpoch: 1,
        chainHead: { seq: 1, eventDigest: "digest-1" },
        issuer: {
          deviceId: authorityA.deviceId,
          issuerKeyId: authorityA.deviceId,
          issuerPublicKey: `public-key-${authorityA.deviceId}`,
        },
        members: [
          {
            state: "active",
            roles: ["anchor"],
            device: deviceIdentity(authorityA.deviceId),
          },
          {
            state: "active",
            roles: ["executor", "surface"],
            device: deviceIdentity(execO.deviceId),
          },
          {
            state: "active",
            roles: ["surface"],
            device: deviceIdentity(deviceH),
          },
        ],
      };

      const scenes = [
        {
          sceneId: "scene-uninit",
          name: "待初始化工作场景",
          lastActiveAt: "2020-01-01T00:00:00.000Z",
        },
      ];
      const workscenesA = {
        query: async (desc: unknown) => {
          if (desc !== WORKSCENE_MANAGEMENT_LIST_QUERY) {
            throw new Error("unexpected query");
          }
          return { scenes };
        },
      };

      const servicesA = new MeshServiceRegistry();
      const connectionsA = new MeshConnectionRegistry();
      const servicesO = new MeshServiceRegistry();
      const connectionsO = new MeshConnectionRegistry();
      const servicesH = new MeshServiceRegistry();
      const connectionsH = new MeshConnectionRegistry();

      let anchorActivityCount = 0;
      const peerHasRole = (
        id: string,
        role: "anchor" | "executor" | "surface",
      ) =>
        trust.members.some(
          (m) =>
            m.state === "active" &&
            m.device.deviceId === id &&
            m.roles.includes(role),
        );
      const isActiveMember = (id: string) =>
        trust.members.some((m) => m.state === "active" && m.device.deviceId === id);

      const hostProgramA: HostProgramConversationController =
        createHostProgramConversationApplication({
          anchor: {
            protocol: protocolA,
            manager: managerA,
            directory: storageA.directory,
            workscenes: workscenesA as never,
            onAdmissionActivity: () => {
              anchorActivityCount += 1;
            },
          },
          topology: {
            deviceId: authorityA.deviceId,
            currentTrust: () => trust,
            remoteOwnedFor: (id) =>
              connectionsA.has(id)
                ? new ProgramConversationMeshClient(() => connectionsA.client(id))
                : undefined,
          },
        });

      const rawLocalOwnedO = createLocalOwnedProgramConversationHandler({
        deviceId: execO.deviceId,
        local: { owner: execO.ownerPort },
      });
      let onNextOwnedResultEntered: (() => void) | undefined;
      // Spy waitMs & signal on ownedResult so we prove hop elapsed-time deduction and SIGINT propagation!
      const spiedLocalOwnedO = {
        ...rawLocalOwnedO,
        ownedResult: async (
          input: Parameters<typeof rawLocalOwnedO.ownedResult>[0],
          signal?: AbortSignal,
        ) => {
          execO.observeWaitMs.push(input.waitMs ?? 0);
          if (signal) execO.observedSignals.push(signal);
          const hook = onNextOwnedResultEntered;
          onNextOwnedResultEntered = undefined;
          hook?.();
          return rawLocalOwnedO.ownedResult(input, signal);
        },
      };

      const executorProgramO = createExecutorProgramConversationApplication({
        deviceId: execO.deviceId,
        currentAnchorDeviceId: () => authorityA.deviceId,
        local: { owner: execO.ownerPort },
        anchorRemote: () =>
          connectionsO.has(authorityA.deviceId)
            ? new ProgramConversationMeshClient(() =>
                connectionsO.client(authorityA.deviceId),
              )
            : undefined,
        isAnchorReachable: () => connectionsO.has(authorityA.deviceId),
      });

      // Singleton registration on Anchor A and Executor O
      expect(PROGRAM_CONVERSATION_MESH_SERVICE).toBe("conversation.program");
      registerProgramConversationMeshService({
        registry: servicesA,
        isActiveMember,
        peerHasRole,
        isCurrentAnchor: () => true,
        currentAnchorDeviceId: () => authorityA.deviceId,
        anchorCoordinator: () => hostProgramA,
        localOwned: () => undefined, // Pure Anchor has no localConversationOwner
        onActivity: () => {
          anchorActivityCount += 1;
        },
      });
      expect(() =>
        registerProgramConversationMeshService({
          registry: servicesA,
          isActiveMember,
          peerHasRole,
          isCurrentAnchor: () => true,
          currentAnchorDeviceId: () => authorityA.deviceId,
          anchorCoordinator: () => hostProgramA,
        }),
      ).toThrow(/already registered/);

      registerProgramConversationMeshService({
        registry: servicesO,
        isActiveMember,
        peerHasRole,
        isCurrentAnchor: () => false,
        currentAnchorDeviceId: () => authorityA.deviceId,
        localOwned: () => spiedLocalOwnedO,
      });

      let linkHA = await connectInMemoryMeshPair({
        leftDeviceId: deviceH,
        leftServices: servicesH,
        leftConnections: connectionsH,
        rightDeviceId: authorityA.deviceId,
        rightServices: servicesA,
        rightConnections: connectionsA,
      });
      let linkOA = await connectInMemoryMeshPair({
        leftDeviceId: execO.deviceId,
        leftServices: servicesO,
        leftConnections: connectionsO,
        rightDeviceId: authorityA.deviceId,
        rightServices: servicesA,
        rightConnections: connectionsA,
      });
      // Direct H <-> O link ONLY for testing negative authorization boundaries!
      const linkHO = await connectInMemoryMeshPair({
        leftDeviceId: deviceH,
        leftServices: servicesH,
        leftConnections: connectionsH,
        rightDeviceId: execO.deviceId,
        rightServices: servicesO,
        rightConnections: connectionsO,
      });

      const surfaceClientH = new CurrentAnchorSurfaceRpcClient(
        deviceH,
        {
          start: async () => {},
          stop: async () => {},
          currentTrust: () => trust,
          connections: connectionsH,
        },
        { stopStorageMaintenance: async () => {} },
      );

      try {
        const localConvO = await execO.createLocalConversation(
          "01JDCX00000000000000000001",
          "O 本机开发会话",
          "2026-11-23T16:00:00.000Z",
        );

        // ─── 1. Authorization Negative Cases (zero writes!) ───
        const directHToO = new ProgramConversationMeshClient(() =>
          connectionsH.client(execO.deviceId),
        );
        // 1a. op: "entry" sent to non-Anchor O -> unauthorized (exit 1), zero writes
        await expect(
          directHToO.send({
            conversationId: localConvO,
            requestId: "unauth-entry-to-o",
            text: "illegal direct entry",
          }),
        ).rejects.toMatchObject({
          code: "unauthorized",
          options: { exitCode: 1, retryable: false },
        });
        expect(execO.admittedCountFor(localConvO)).toBe(0);

        // 1b. op: "owned" sent directly from non-Anchor H to O -> unauthorized (exit 1), zero writes
        await expect(
          directHToO.ownedSend({
            conversationId: localConvO,
            requestId: "unauth-owned-from-h",
            text: "illegal owned from surface",
          }),
        ).rejects.toMatchObject({
          code: "unauthorized",
          options: { exitCode: 1, retryable: false },
        });
        expect(execO.admittedCountFor(localConvO)).toBe(0);

        // 1c. op: "owned" sent from Anchor A to O for out-of-scope conversationId -> unauthorized (exit 1), zero writes
        const aToO = new ProgramConversationMeshClient(() =>
          connectionsA.client(execO.deviceId),
        );
        await expect(
          aToO.ownedSend({
            conversationId: "local-deadbeef-01JDCX00000000000000000099",
            requestId: "unauth-wrong-prefix",
            text: "out of scope",
          }),
        ).rejects.toMatchObject({
          code: "unauthorized",
          options: { exitCode: 1, retryable: false },
        });
        await expect(
          aToO.ownedSend({
            conversationId: "default",
            requestId: "unauth-non-local",
            text: "non-local id",
          }),
        ).rejects.toMatchObject({
          code: "unauthorized",
          options: { exitCode: 1, retryable: false },
        });

        // 1d. Pure surface H trying internal-only discover-internal or creatorConversationId -> unauthorized
        const rawHToA = new ProgramConversationMeshClient(() =>
          connectionsH.client(authorityA.deviceId),
        );
        await expect(rawHToA.discoverInternal({})).rejects.toMatchObject({
          code: "unauthorized",
        });
        await expect(
          rawHToA.create(
            { requestId: "unauth-creator" },
            undefined,
            "spoofed-conv",
          ),
        ).rejects.toMatchObject({ code: "unauthorized" });

        // 1e. CurrentAnchorSurfaceRpcClient zero relaxation for non-program methods
        await surfaceClientH.connect();
        await expect(
          surfaceClientH.request("server.shutdown", {}),
        ).rejects.toThrow(/设备本地或未知方法不能通过 current anchor 接入面代理/);
        await expect(
          surfaceClientH.request("logs.search", {}),
        ).rejects.toThrow(/设备本地或未知方法不能通过 current anchor 接入面代理/);
        expect(() =>
          surfaceClientH.maximumRequestSourceBytes("server.shutdown"),
        ).toThrow(/设备本地或未知方法不能通过 current anchor 接入面代理/);

        // ─── 2. Full H -> A -> O Loop, Activity Bump, and Outer < 1 MiB Envelope Budget ───
        const prevActivity = anchorActivityCount;
        const listCap = captureCliIO({
          zhixingHome: homeH,
          openClient: surfaceHandleFor(surfaceClientH),
        });
        expect(
          await runConversationListCommand({ json: true }, listCap.io),
        ).toBe(0);
        const listJson = JSON.parse(listCap.stdoutText);
        expect(listJson.partial).toBe(false);
        expect(listJson.entries.map((e: { canonicalKey: string }) => e.canonicalKey)).toEqual([
          localConvO,
          worksceneConversationId("scene-uninit", "primary"),
        ]);
        expect(anchorActivityCount).toBeGreaterThan(prevActivity);

        // H initializes workscene conversation on A via `new --scene`
        const newCap = captureCliIO({
          zhixingHome: homeH,
          openClient: surfaceHandleFor(surfaceClientH),
        });
        expect(
          await runConversationNewCommand(
            { scene: "scene-uninit", id: "req-h-new-ws" },
            newCap.io,
          ),
        ).toBe(0);
        expect(newCap.stdoutText.trim()).toBe("ws:scene-uninit:primary");

        // Outer Mesh envelope < 1 MiB budget check on CurrentAnchorSurfaceRpcClient (requestEncoded & maximumRequestSourceBytes)
        const maxSurfaceBytes = surfaceClientH.maximumRequestSourceBytes(
          "conversation.program.send",
        );
        expect(maxSurfaceBytes).toBeLessThan(PROGRAM_SINGLE_FRAME_MAX_BYTES);
        expect(maxSurfaceBytes).toBeGreaterThan(
          PROGRAM_SINGLE_FRAME_MAX_BYTES - 1024,
        );
        const borderlineBytes = maxSurfaceBytes + 32;
        await expect(
          surfaceClientH.requestEncoded("conversation.program.send", {
            byteLength: borderlineBytes,
            open: () => ({
              read: async () => Buffer.alloc(0),
              release: () => {},
            }),
          }),
        ).rejects.toSatisfy(
          (e: unknown) =>
            e instanceof RpcClientError &&
            (e.data as { programError?: { code?: string } })?.programError
              ?.code === "payload_too_large",
        );

        // ─── 3. Cross-Hop > 30s Wait Slice Deduction, SIGINT Cancel Propagation, & > 1 MiB Result/Read Paging ───
        let releaseSlowRunO!: () => void;
        const slowRunGateO = new Promise<void>((r) => {
          releaseSlowRunO = r;
        });
        const largeAnswerO =
          "跨设备大回复段落-" + "知行Mesh分页测试内容\n".repeat(42_000) + "-END";
        expect(Buffer.byteLength(largeAnswerO, "utf8")).toBeGreaterThan(
          PROGRAM_SINGLE_FRAME_MAX_BYTES,
        );
        execO.setReplyResponder(async (prompt) => {
          await slowRunGateO;
          return `${prompt.split("\n")[0]} => ${largeAnswerO}`;
        });

        let ticketHO!: string;
        try {
          const sigBus = new EventEmitter();
          const sendSigCap = captureCliIO({
            zhixingHome: homeH,
            signals: sigBus as never,
            openClient: surfaceHandleFor(surfaceClientH),
          });
          onNextOwnedResultEntered = () => {
            setTimeout(() => sigBus.emit("SIGINT"), 15);
          };
          const multilineVerbatim = "/exit\n--version\n```sh\necho hello\n```";
          const sendSigExit = await runConversationSendCommand(
            localConvO,
            { text: multilineVerbatim, id: "req-h-to-o-1", wait: "45" },
            sendSigCap.io,
          );
          expect(sendSigExit).toBe(2);
          ticketHO = sendSigCap.stdoutText.trim();
          expect(ticketHO.startsWith("zxt1.")).toBe(true);
          // Verify O received bounded <= 15s slice (with hop overhead deducted) and AbortSignal aborted on SIGINT WITHOUT cancelling run!
          expect(execO.observeWaitMs.length).toBeGreaterThanOrEqual(1);
          expect(execO.observeWaitMs[0]!).toBeLessThanOrEqual(
            PROGRAM_MAX_WAIT_SLICE_MS,
          );
          const abortDeadline = Date.now() + 1_000;
          while (
            !execO.observedSignals.some((s) => s.aborted) &&
            Date.now() < abortDeadline
          ) {
            await new Promise((r) => setTimeout(r, 10));
          }
          expect(execO.observedSignals.some((s) => s.aborted)).toBe(true);

          // Now release O's run and retrieve > 1 MiB multi-page answer across O -> A -> H!
          releaseSlowRunO();
          const resCap = captureCliIO({
            zhixingHome: homeH,
            openClient: surfaceHandleFor(surfaceClientH),
          });
          expect(
            await runConversationResultCommand(
              ticketHO,
              { wait: "35" },
              resCap.io,
            ),
          ).toBe(0);
          expect(resCap.stdoutText).toBe(`/exit => ${largeAnswerO}\n`);
          expect(execO.admittedCountFor(localConvO)).toBe(1);
        } finally {
          releaseSlowRunO();
        }

        // ─── 3b. Cursor Validation & Generation Reset Semantics Across H, O, and A (F2 Regression) ───
        {
          // Page 1 & normal same-run continuation on O's multi-page run via H -> A -> O
          const p1Cap = captureCliIO({
            zhixingHome: homeH,
            openClient: surfaceHandleFor(surfaceClientH),
          });
          expect(
            await runConversationResultCommand(
              ticketHO,
              { json: true },
              p1Cap.io,
            ),
          ).toBe(0);
          const p1Json = JSON.parse(p1Cap.stdoutText) as {
            state: string;
            runId: string;
            answerTruncated: boolean;
            nextCursor: string;
          };
          expect(p1Json.state).toBe("completed");
          expect(p1Json.answerTruncated).toBe(true);
          expect(typeof p1Json.nextCursor).toBe("string");

          const p2Cap = captureCliIO({
            zhixingHome: homeH,
            openClient: surfaceHandleFor(surfaceClientH),
          });
          expect(
            await runConversationResultCommand(
              ticketHO,
              { json: true, cursor: p1Json.nextCursor },
              p2Cap.io,
            ),
          ).toBe(0);
          expect(JSON.parse(p2Cap.stdoutText)).toMatchObject({
            state: "completed",
            runId: p1Json.runId,
          });

          // Create a second committed run on localConvO AND an Anchor-owned multi-page run on ws:scene-uninit:primary
          execO.setReplyResponder(async (p) => `short-run-2:${p}`);
          const sendO2Cap = captureCliIO({
            zhixingHome: homeH,
            openClient: surfaceHandleFor(surfaceClientH),
          });
          expect(
            await runConversationSendCommand(
              localConvO,
              { text: "第二轮用于错游标校验", id: "req-h-to-o-2", wait: "10", json: true },
              sendO2Cap.io,
            ),
          ).toBe(0);
          const ticketHO2 = (JSON.parse(sendO2Cap.stdoutText) as { ticket: string }).ticket;

          const largeAnswerA =
            "主控多页回复段落-" + "知行主控分页续读校验\n".repeat(42_000) + "-AEND";
          anchorResponder = async () => largeAnswerA;
          const sendWs1Cap = captureCliIO({
            zhixingHome: homeH,
            openClient: surfaceHandleFor(surfaceClientH),
          });
          expect(
            await runConversationSendCommand(
              "ws:scene-uninit:primary",
              { text: "触发主控超长回复", id: "req-ws-large-1", wait: "10", json: true },
              sendWs1Cap.io,
            ),
          ).toBe(0);
          const wsP1Json = JSON.parse(sendWs1Cap.stdoutText) as {
            ticket: string;
            runId: string;
            answerTruncated: boolean;
            nextCursor: string;
          };
          expect(wsP1Json.answerTruncated).toBe(true);
          expect(typeof wsP1Json.nextCursor).toBe("string");

          const execOnlineHandle = async (): Promise<ProgramConversationClientHandle> => ({
            facade: {
              ensureConnected: async () => {},
              list: (i, s) => executorProgramO.list(i, s),
              create: (i, s) => executorProgramO.create(i, s),
              read: (i, s) => executorProgramO.read(i, s),
              send: (i, s) => executorProgramO.send(i, s),
              result: (i, s) => executorProgramO.result(i, s),
            },
            dispose: async () => {},
          });
          const anchorOnlineHandle = async (): Promise<ProgramConversationClientHandle> => ({
            facade: {
              ensureConnected: async () => {},
              list: (i, s) => hostProgramA.list(i, s),
              create: (i, s) => hostProgramA.create(i, s),
              read: (i, s) => hostProgramA.read(i, s),
              send: (i, s) => hostProgramA.send(i, s),
              result: (i, s) => hostProgramA.result(i, s),
            },
            dispose: async () => {},
          });

          // Wrong-run cursor (p1Json.nextCursor belongs to req-h-to-o-1, passed to req-h-to-o-2) & malformed cursor across H, O, A -> exit 1 invalid_cursor (retryable: false)!
          for (const [label, home, openClient, targetConv, targetReq, badCursor] of [
            ["H->A->O wrong-run", homeH, surfaceHandleFor(surfaceClientH), localConvO, "req-h-to-o-2", p1Json.nextCursor],
            ["H->A->O malformed", homeH, surfaceHandleFor(surfaceClientH), localConvO, "req-h-to-o-2", "zxc1.not-valid-base64"],
            ["O-local wrong-run", execO.home, execOnlineHandle, localConvO, "req-h-to-o-2", p1Json.nextCursor],
            ["O->A-remote wrong-conv", execO.home, execOnlineHandle, "ws:scene-uninit:primary", "req-ws-large-1", p1Json.nextCursor],
            ["A-local wrong-conv", homeH, anchorOnlineHandle, "ws:scene-uninit:primary", "req-ws-large-1", p1Json.nextCursor],
            ["A->O-remote wrong-run", homeH, anchorOnlineHandle, localConvO, "req-h-to-o-2", p1Json.nextCursor],
          ] as const) {
            const badCap = captureCliIO({ zhixingHome: home, openClient });
            const badExit = await runConversationResultCommand(
              undefined,
              { to: targetConv, id: targetReq, cursor: badCursor, json: true },
              badCap.io,
            );
            expect(badExit, label).toBe(1);
            expect(JSON.parse(badCap.stdoutText), label).toMatchObject({
              error: { code: "invalid_cursor", retryable: false },
            });
          }

          // Genuine authority generation reset (stale ownerEpoch on both O leaf ownedResult and A Anchor.result):
          // Returns state: "cursor_expired" WITH runState: "committed" (exit 3 in --json), and text re-read from page 1 assembles full answer (exit 0)!
          const decodedO = decodeProgramBodyCursor(
            p1Json.nextCursor,
            "result-answer",
            localConvO,
            p1Json.runId,
          );
          const staleEpochCursorO = encodeProgramBodyCursor({
            v: 1,
            kind: "result-answer",
            runId: p1Json.runId,
            previousBlock: decodedO.previousBlock,
            bodyCursor: {
              ...decodedO.bodyCursor,
              ownerEpoch: decodedO.bodyCursor.ownerEpoch + 1,
            },
          });
          const expOCap = captureCliIO({
            zhixingHome: homeH,
            openClient: surfaceHandleFor(surfaceClientH),
          });
          expect(
            await runConversationResultCommand(
              ticketHO,
              { json: true, cursor: staleEpochCursorO },
              expOCap.io,
            ),
          ).toBe(3);
          expect(JSON.parse(expOCap.stdoutText)).toMatchObject({
            state: "cursor_expired",
            runId: p1Json.runId,
            runState: "committed",
            error: { code: "cursor_expired", retryable: true },
          });

          const decodedA = decodeProgramBodyCursor(
            wsP1Json.nextCursor,
            "result-answer",
            "ws:scene-uninit:primary",
            wsP1Json.runId,
          );
          const staleEpochCursorA = encodeProgramBodyCursor({
            v: 1,
            kind: "result-answer",
            runId: wsP1Json.runId,
            previousBlock: decodedA.previousBlock,
            bodyCursor: {
              ...decodedA.bodyCursor,
              ownerEpoch: decodedA.bodyCursor.ownerEpoch + 1,
            },
          });
          const expACap = captureCliIO({
            zhixingHome: homeH,
            openClient: surfaceHandleFor(surfaceClientH),
          });
          expect(
            await runConversationResultCommand(
              wsP1Json.ticket,
              { json: true, cursor: staleEpochCursorA },
              expACap.io,
            ),
          ).toBe(3);
          expect(JSON.parse(expACap.stdoutText)).toMatchObject({
            state: "cursor_expired",
            runId: wsP1Json.runId,
            runState: "committed",
            error: { code: "cursor_expired", retryable: true },
          });

          const rereadWsFullCap = captureCliIO({
            zhixingHome: homeH,
            openClient: surfaceHandleFor(surfaceClientH),
          });
          expect(
            await runConversationResultCommand(
              wsP1Json.ticket,
              {},
              rereadWsFullCap.io,
            ),
          ).toBe(0);
          expect(rereadWsFullCap.stdoutText).toBe(`${largeAnswerA}\n`);
        }

        // Read > 1 MiB single-turn history across O -> A -> H using --before pagination
        const readPage1Cap = captureCliIO({
          zhixingHome: homeH,
          openClient: surfaceHandleFor(surfaceClientH),
        });
        expect(
          await runConversationReadCommand(
            localConvO,
            { limit: "5", json: true },
            readPage1Cap.io,
          ),
        ).toBe(0);
        expect(Buffer.byteLength(readPage1Cap.stdoutText, "utf8")).toBeLessThan(
          PROGRAM_SINGLE_FRAME_MAX_BYTES,
        );
        const readPage1 = JSON.parse(readPage1Cap.stdoutText);
        expect(readPage1.hasMore).toBe(true);
        expect(typeof readPage1.nextBefore).toBe("string");

        // Full text mode `read` automatically stitches all < 1 MiB fragments across hops!
        const readFullCap = captureCliIO({
          zhixingHome: homeH,
          openClient: surfaceHandleFor(surfaceClientH),
        });
        expect(
          await runConversationReadCommand(
            localConvO,
            { limit: "5" },
            readFullCap.io,
          ),
        ).toBe(0);
        expect(readFullCap.stdoutText).toContain("◇ 来自外部程序:");
        expect(readFullCap.stdoutText).toContain("-END");

        // ─── 4. Pure Executor Anchor-Offline Local Autonomy ───
        await linkOA.disconnect();
        execO.setReplyResponder(async (p) => `offline-local-ok:${p}`);

        const offlineList = await executorProgramO.list({});
        expect(offlineList.partial).toBe(true);
        expect(offlineList.unreachableDevices).toEqual([authorityA.deviceId]);
        expect(
          offlineList.entries.map((e) => e.canonicalKey),
        ).toContain(localConvO);

        // `new` on pure executor while Anchor is offline preserves requestId and exits 3!
        const execOfflineHandle = async (): Promise<ProgramConversationClientHandle> => ({
          facade: {
            ensureConnected: async () => {},
            list: (i, s) => executorProgramO.list(i, s),
            create: (i, s) => executorProgramO.create(i, s),
            read: (i, s) => executorProgramO.read(i, s),
            send: (i, s) => executorProgramO.send(i, s),
            result: (i, s) => executorProgramO.result(i, s),
          },
          dispose: async () => {},
        });
        const offlineNewCap = captureCliIO({
          zhixingHome: execO.home,
          openClient: execOfflineHandle,
        });
        expect(
          await runConversationNewCommand(
            { name: "离线新建", id: "req-offline-new-1", json: true },
            offlineNewCap.io,
          ),
        ).toBe(3);
        expect(JSON.parse(offlineNewCap.stdoutText)).toMatchObject({
          requestId: "req-offline-new-1",
          error: { code: "temporarily_unavailable", retryable: true },
        });

        // `send`, `result`, and `read` on O's own `current` `local-*` succeed 100% locally while Anchor is offline!
        const offlineSendCap = captureCliIO({
          zhixingHome: execO.home,
          openClient: execOfflineHandle,
        });
        expect(
          await runConversationSendCommand(
            localConvO,
            { text: "主控离线本机自治消息", id: "req-offline-local-1", wait: "10" },
            offlineSendCap.io,
          ),
        ).toBe(0);
        expect(offlineSendCap.stdoutText).toBe(
          "offline-local-ok:主控离线本机自治消息\n",
        );

        // Meanwhile on H (connected to A while O is offline and un-adopted):
        // `list` sets `partial: true`, `send/result/read` to `localConvO` return exit 3 (never `not_found`!)
        const hListWhileOOffline = captureCliIO({
          zhixingHome: homeH,
          openClient: surfaceHandleFor(surfaceClientH),
        });
        expect(
          await runConversationListCommand(
            { json: true },
            hListWhileOOffline.io,
          ),
        ).toBe(0);
        expect(JSON.parse(hListWhileOOffline.stdoutText)).toMatchObject({
          partial: true,
          unreachableDevices: [execO.deviceId],
        });

        const hSendWhileOOffline = captureCliIO({
          zhixingHome: homeH,
          openClient: surfaceHandleFor(surfaceClientH),
        });
        expect(
          await runConversationSendCommand(
            localConvO,
            { text: "O离线期间尝试", id: "req-o-offline", json: true },
            hSendWhileOOffline.io,
          ),
        ).toBe(3);
        expect(JSON.parse(hSendWhileOOffline.stdoutText)).toMatchObject({
          state: "temporarily_unavailable",
          requestId: "req-o-offline",
        });

        // ─── 5. Adoption onto A + O Shut Down: Old Ticket Reconciliation, Paired HOME_OTHER Check, & Adopted-Then-Deleted ───
        // Simulate committed adoption of `localAdoptedConv` onto Anchor A while O remains shut down/disconnected!
        const localAdoptedConv = localConversationId(
          execO.deviceId,
          "01JDCX00000000000000000002",
        );
        adoptedIdsOnA.add(localAdoptedConv);
        await protocolA.ensureSession(localAdoptedConv);
        await storageA.directory.ensure(localAdoptedConv, {
          name: "已接管本机对话",
        });
        anchorResponder = async (p) => `adopted-on-anchor:${p}`;

        let adoptedDeletedOnA = false;
        const adoptedAwareProtocolA = new Proxy(protocolA, {
          get(target, prop) {
            if (prop === "listAdoptedConversationIds") {
              return async () => [localAdoptedConv];
            }
            if (prop === "conversationAdoptionStatus") {
              return async (id: string) => {
                const base = await target.conversationAdoptionStatus(id);
                if (id === localAdoptedConv) {
                  return {
                    ...base,
                    adopted: true,
                    deleted: adoptedDeletedOnA,
                    hasDurableIdentity: !adoptedDeletedOnA,
                  };
                }
                return base;
              };
            }
            const v = Reflect.get(target, prop, target);
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
        const adoptedHostA = createHostProgramConversationApplication({
          anchor: {
            protocol: adoptedAwareProtocolA,
            manager: managerA,
            directory: storageA.directory,
            workscenes: workscenesA as never,
          },
          topology: {
            deviceId: authorityA.deviceId,
            currentTrust: () => trust,
            remoteOwnedFor: () => undefined, // O is completely shut down!
          },
        });
        const adoptedAdmit = await adoptedHostA.send({
          conversationId: localAdoptedConv,
          requestId: "req-before-adoption",
          text: "迁移前已接纳请求",
        });
        expect(adoptedAdmit.admitted).toBe(true);
        if (!adoptedAdmit.admitted) throw new Error("expected admitted");
        await adoptedHostA.result({
          conversationId: localAdoptedConv,
          requestId: "req-before-adoption",
          waitMs: 5_000,
        });
        const adoptedServicesA = new MeshServiceRegistry();
        registerProgramConversationMeshService({
          registry: adoptedServicesA,
          isActiveMember,
          peerHasRole,
          isCurrentAnchor: () => true,
          currentAnchorDeviceId: () => authorityA.deviceId,
          anchorCoordinator: () => adoptedHostA,
        });
        await linkHA.disconnect();
        linkHA = await connectInMemoryMeshPair({
          leftDeviceId: deviceH,
          leftServices: servicesH,
          leftConnections: connectionsH,
          rightDeviceId: authorityA.deviceId,
          rightServices: adoptedServicesA,
          rightConnections: connectionsA,
        });

        const oldTicketFromH = encodeProgramConversationTicket({
          homeId: await programHomeId(homeH),
          conversationId: localAdoptedConv,
          requestId: "req-before-adoption",
        });

        // 5a. Original HOME_H reconciles old ticket on A while O is shut down -> exit 0!
        const oldTicketResCap = captureCliIO({
          zhixingHome: homeH,
          openClient: surfaceHandleFor(surfaceClientH),
        });
        expect(
          await runConversationResultCommand(
            oldTicketFromH,
            { json: true },
            oldTicketResCap.io,
          ),
        ).toBe(0);
        const oldTicketJson = JSON.parse(oldTicketResCap.stdoutText);
        expect(oldTicketJson).toMatchObject({
          state: "completed",
          runId: adoptedAdmit.runId,
          answer: "adopted-on-anchor:迁移前已接纳请求",
        });

        // 5b. Same-key same-text replay returns same runId; different text returns idempotency_conflict (exit 1)
        const replaySameCap = captureCliIO({
          zhixingHome: homeH,
          openClient: surfaceHandleFor(surfaceClientH),
        });
        expect(
          await runConversationSendCommand(
            localAdoptedConv,
            {
              text: "迁移前已接纳请求",
              id: "req-before-adoption",
              wait: false,
              sawNoWait: true,
              json: true,
            },
            replaySameCap.io,
          ),
        ).toBe(2);
        expect(JSON.parse(replaySameCap.stdoutText)).toMatchObject({
          admitted: true,
          replayed: true,
          runId: adoptedAdmit.runId,
        });

        const replayDiffCap = captureCliIO({
          zhixingHome: homeH,
          openClient: surfaceHandleFor(surfaceClientH),
        });
        expect(
          await runConversationSendCommand(
            localAdoptedConv,
            {
              text: "篡改后的不同内容",
              id: "req-before-adoption",
              json: true,
            },
            replayDiffCap.io,
          ),
        ).toBe(1);
        expect(JSON.parse(replayDiffCap.stdoutText)).toMatchObject({
          admitted: false,
          error: { code: "idempotency_conflict" },
        });

        // 5c. Paired HOME_OTHER verification on the exact same target:
        // Reusing HOME_H's ticket fails with `invalid_ticket` (exit 1), whereas `--to + --id` retrieves the exact same runId (exit 0)!
        const crossHomeTicketCap = captureCliIO({
          zhixingHome: homeOther,
          openClient: surfaceHandleFor(surfaceClientH),
        });
        expect(
          await runConversationResultCommand(
            oldTicketFromH,
            { json: true },
            crossHomeTicketCap.io,
          ),
        ).toBe(1);
        expect(JSON.parse(crossHomeTicketCap.stdoutText)).toMatchObject({
          error: { code: "invalid_ticket" },
        });

        const crossHomeExplicitCap = captureCliIO({
          zhixingHome: homeOther,
          openClient: surfaceHandleFor(surfaceClientH),
        });
        expect(
          await runConversationResultCommand(
            undefined,
            {
              to: localAdoptedConv,
              id: "req-before-adoption",
              json: true,
            },
            crossHomeExplicitCap.io,
          ),
        ).toBe(0);
        expect(JSON.parse(crossHomeExplicitCap.stdoutText)).toMatchObject({
          state: "completed",
          runId: adoptedAdmit.runId,
          answer: "adopted-on-anchor:迁移前已接纳请求",
        });

        // 5d. Delete adopted conversation on A while O remains shut down -> returns `target_deleted` (exit 1), never routing back to offline O!
        adoptedDeletedOnA = true;
        const deletedAdoptedCap = captureCliIO({
          zhixingHome: homeH,
          openClient: surfaceHandleFor(surfaceClientH),
        });
        expect(
          await runConversationResultCommand(
            oldTicketFromH,
            { json: true },
            deletedAdoptedCap.io,
          ),
        ).toBe(1);
        expect(JSON.parse(deletedAdoptedCap.stdoutText)).toMatchObject({
          state: "target_deleted",
          error: { code: "target_deleted" },
        });

        // ─── 6. Leaf Late `fenced` Single-Hop Recheck & Two-Hop Dropped Response ───
        // Restore normal A <-> O connection
        await linkHA.disconnect();
        linkHA = await connectInMemoryMeshPair({
          leftDeviceId: deviceH,
          leftServices: servicesH,
          leftConnections: connectionsH,
          rightDeviceId: authorityA.deviceId,
          rightServices: servicesA,
          rightConnections: connectionsA,
        });
        linkOA = await connectInMemoryMeshPair({
          leftDeviceId: execO.deviceId,
          leftServices: servicesO,
          leftConnections: connectionsO,
          rightDeviceId: authorityA.deviceId,
          rightServices: servicesA,
          rightConnections: connectionsA,
        });

        // 6a. Leaf O transitions to `fenced` before admission -> returns exit 3 preserving ticket, zero writes on O!
        execO.setAuthorityOverride(localConvO, "fenced");
        const fencedCap = captureCliIO({
          zhixingHome: homeH,
          openClient: surfaceHandleFor(surfaceClientH),
        });
        expect(
          await runConversationSendCommand(
            localConvO,
            { text: "迟到栅栏测试", id: "req-late-fenced", json: true },
            fencedCap.io,
          ),
        ).toBe(3);
        expect(JSON.parse(fencedCap.stdoutText)).toMatchObject({
          state: "temporarily_unavailable",
          requestId: "req-late-fenced",
        });
        execO.setAuthorityOverride(localConvO, undefined);

        // 6b. Two-hop dropped response: O commits `owned-send`, then O -> A reply transport drops!
        const beforeCount = execO.admittedCountFor(localConvO);
        linkOA.leftTransport.dropNextSend = true; // Drop O's response frame back to A!
        const drop2HopCap = captureCliIO({
          zhixingHome: homeH,
          openClient: surfaceHandleFor(surfaceClientH),
        });
        const drop2HopExit = await runConversationSendCommand(
          localConvO,
          { text: "两跳丢回执不重入", id: "req-2hop-drop", json: true },
          drop2HopCap.io,
        );
        expect(drop2HopExit).toBe(3);
        const drop2HopJson = JSON.parse(drop2HopCap.stdoutText);
        expect(drop2HopJson.ticket.startsWith("zxt1.")).toBe(true);

        // Reconnect O <-> A and recover via `result <ticket>` + same-key replay -> total admissions === beforeCount + 1!
        linkOA = await connectInMemoryMeshPair({
          leftDeviceId: execO.deviceId,
          leftServices: servicesO,
          leftConnections: connectionsO,
          rightDeviceId: authorityA.deviceId,
          rightServices: servicesA,
          rightConnections: connectionsA,
        });
        const recover2HopCap = captureCliIO({
          zhixingHome: homeH,
          openClient: surfaceHandleFor(surfaceClientH),
        });
        expect(
          await runConversationResultCommand(
            drop2HopJson.ticket,
            { wait: "10" },
            recover2HopCap.io,
          ),
        ).toBe(0);
        expect(recover2HopCap.stdoutText).toBe(
          "offline-local-ok:两跳丢回执不重入\n",
        );
        expect(execO.admittedCountFor(localConvO)).toBe(beforeCount + 1);
      } finally {
        await surfaceClientH.close();
        await linkHO.disconnect();
        await linkOA.disconnect();
        await linkHA.disconnect();
        await execO.close();
        await protocolA.stopRecoveryLoop();
        await managerA.disposeAll();
        await authorityA.stopStorageMaintenance();
      }
    },
    TEST_DURABLE_IO_TIMEOUT_MS,
  );

  it(
    "disambiguates same 8-char devicePrefix across E1/E2, enables cross-node internal discover/new (with legacy peer partial: true), and distinguishes incompatible-version vs service-unavailable",
    async () => {
      const homeA = await createTempDir("mesh-anchor-e1e2");
      const homeCli = await createTempDir("mesh-cli-e1e2");
      const authorityA = await setupAuthorityRuntime({
        zhixingHome: homeA,
        secretStore: new MemorySecretStore(),
        deviceId: "99999999-0000-4999-8999-999999999999",
      });
      await authorityA.installPermissionSnapshot(
        createSignedTrustRuleSnapshot(
          { snapshotVersion: 1, rules: [], generatedAt: new Date().toISOString() },
          authorityA.signer,
        ),
      );
      const storageA = createConversationStorageInfrastructure({
        zhixingHome: homeA,
        optimalMaxTokens: 32_000,
        worksceneConversationStorageRemoval: { isRemoving: () => false } as never,
      });
      const runtimeFactoryA: RuntimeFactory = {
        create: async (id) => ({
          ...TEST_RUNTIME_AUTHORITY_FACTS,
          sessionId: id,
          async *run(history: readonly Message[]): AsyncGenerator<AgentYield, RunResult> {
            const lastUser = history.at(-1)!;
            const msg = assistantMessage("anchor-ok");
            yield { type: "text_delta", text: "anchor-ok" };
            return {
              agentResult: {
                reason: "completed",
                message: msg,
                usage: { inputTokens: 2, outputTokens: 2 },
              },
              runRecord: {
                timestamp: new Date().toISOString(),
                messages: [lastUser, msg],
                usage: { inputTokens: 2, outputTokens: 2 },
              },
              newMessages: [msg],
              durationMs: 1,
            };
          },
          abort: () => false,
          dispose: async () => {},
        }),
      };
      let managerA!: ConversationManager;
      const protocolA = createProtocol({
        authority: authorityA,
        manager: () => managerA,
        interactions: new DurableConversationInteractionObserver(),
      });
      managerA = new ConversationManager(runtimeFactoryA, undefined, {
        durableTurnExecutor: protocolA,
        appendCommittedRun: async (id, record) => {
          await storageA.directory.ensure(id);
          await storageA.directory.touch(id);
          return { runIndex: record.runIndex, shardId: "owner-log", appended: true };
        },
        onTurnCommitted: () => {},
      });

      // E1 and E2 share identical 8-char devicePrefix (`sharedPrefix`)!
      const execE2 = await createStandaloneExecutorHarness("e2");
      const sharedPrefix = /^fp:u([A-Za-z0-9_-]{8})/u.exec(execE2.deviceId)![1]!;
      const execE1 = await createStandaloneExecutorHarness("e1");
      const e1MeshDeviceId = `fp:u${sharedPrefix}-peer-e1-distinct-tail`;
      const legacyExecId = "bbbbbbbb-3333-4333-8333-333333333333";

      const trust: CurrentTrustProjection = {
        homeId: "home-same-prefix",
        trustEpoch: 1,
        anchorEpoch: 1,
        chainHead: { seq: 1, eventDigest: "digest-sp" },
        issuer: {
          deviceId: authorityA.deviceId,
          issuerKeyId: authorityA.deviceId,
          issuerPublicKey: `public-key-${authorityA.deviceId}`,
        },
        members: [
          {
            state: "active",
            roles: ["anchor"],
            device: deviceIdentity(authorityA.deviceId),
          },
          {
            state: "active",
            roles: ["executor", "surface"],
            device: deviceIdentity(e1MeshDeviceId),
          },
          {
            state: "active",
            roles: ["executor", "surface"],
            device: deviceIdentity(execE2.deviceId),
          },
          {
            state: "active",
            roles: ["executor"],
            device: deviceIdentity(legacyExecId),
          },
        ],
      };

      const servicesA = new MeshServiceRegistry();
      const connectionsA = new MeshConnectionRegistry();
      const servicesE1 = new MeshServiceRegistry();
      const connectionsE1 = new MeshConnectionRegistry();
      const servicesE2 = new MeshServiceRegistry();
      const connectionsE2 = new MeshConnectionRegistry();
      const servicesLegacy = new MeshServiceRegistry(); // Legacy executor without `conversation.program`!
      const connectionsLegacy = new MeshConnectionRegistry();

      const isActiveMember = (id: string) =>
        trust.members.some((m) => m.state === "active" && m.device.deviceId === id);
      const peerHasRole = (
        id: string,
        role: "anchor" | "executor" | "surface",
      ) =>
        trust.members.some(
          (m) =>
            m.state === "active" &&
            m.device.deviceId === id &&
            m.roles.includes(role),
        );

      const scenes = [
        {
          sceneId: "scene-remote-tool",
          name: "跨节点内部工具场景",
          lastActiveAt: "2099-01-01T00:00:00.000Z",
        },
      ];
      const hostProgramA = createHostProgramConversationApplication({
        anchor: {
          protocol: protocolA,
          manager: managerA,
          directory: storageA.directory,
          workscenes: {
            query: async () => ({ scenes }),
          } as never,
        },
        topology: {
          deviceId: authorityA.deviceId,
          currentTrust: () => trust,
          remoteOwnedFor: (id) =>
            connectionsA.has(id)
              ? new ProgramConversationMeshClient(() => connectionsA.client(id))
              : undefined,
        },
      });

      registerProgramConversationMeshService({
        registry: servicesA,
        isActiveMember,
        peerHasRole,
        isCurrentAnchor: () => true,
        currentAnchorDeviceId: () => authorityA.deviceId,
        anchorCoordinator: () => hostProgramA,
      });
      registerProgramConversationMeshService({
        registry: servicesE1,
        isActiveMember,
        peerHasRole,
        isCurrentAnchor: () => false,
        currentAnchorDeviceId: () => authorityA.deviceId,
        localOwned: () =>
          createLocalOwnedProgramConversationHandler({
            deviceId: e1MeshDeviceId,
            local: { owner: execE1.ownerPort },
          }),
      });
      registerProgramConversationMeshService({
        registry: servicesE2,
        isActiveMember,
        peerHasRole,
        isCurrentAnchor: () => false,
        currentAnchorDeviceId: () => authorityA.deviceId,
        localOwned: () =>
          createLocalOwnedProgramConversationHandler({
            deviceId: execE2.deviceId,
            local: { owner: execE2.ownerPort },
          }),
      });

      // Register internal `conversation.communication` on Anchor A (Unit 2 enabled!) and non-Anchor E1 (rejects `new` zero-write!)
      const anchorCommBinding = createConversationCommunicationBinding({
        directory: {
          queryList: async () => ({ conversations: [] }),
          queryHistory: async () => ({ runs: [], hasMore: false }),
        } as never,
        manager: managerA,
        messages: {
          inspect: (id, msgId) => protocolA.inspectMessage(id, msgId),
          inputsOutsideHistory: (id) => protocolA.messageInputsOutsideHistory(id),
        },
      });
      registerConversationCommunicationMesh({
        registry: servicesA,
        authorizePeer: (id) => peerHasRole(id, "executor") || peerHasRole(id, "anchor"),
        communication: {
          invoke: async (source, request) => {
            if (request.action === "new") {
              return hostProgramA.createForPrincipal(`conversation:${source}`, {
                requestId: request.operationId,
                ...(request.name !== undefined ? { name: request.name } : {}),
                ...(request.sceneId !== undefined ? { sceneId: request.sceneId } : {}),
              });
            }
            if (isExtendedConversationDiscoverRequest(request)) {
              return hostProgramA.discoverInternal({
                ...(request.query !== undefined ? { query: request.query } : {}),
                ...(request.scope !== undefined ? { scope: request.scope } : {}),
                ...(request.limit !== undefined ? { limit: request.limit } : {}),
                ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
              });
            }
            return request.action === "discover"
              ? discoverConversations([anchorCommBinding], source)
              : anchorCommBinding.invoke(source, request);
          },
        },
      });
      registerConversationCommunicationMesh({
        registry: servicesE1,
        authorizePeer: (id) => peerHasRole(id, "executor") || peerHasRole(id, "anchor"),
        communication: {
          invoke: async (_source, request) => {
            if (request.action === "new") {
              throw new Error("仅当值主控节点可受理跨设备新建对话请求");
            }
            throw new Error("unexpected");
          },
        },
      });

      let linkE1A = await connectInMemoryMeshPair({
        leftDeviceId: e1MeshDeviceId,
        leftServices: servicesE1,
        leftConnections: connectionsE1,
        rightDeviceId: authorityA.deviceId,
        rightServices: servicesA,
        rightConnections: connectionsA,
      });
      const linkE2A = await connectInMemoryMeshPair({
        leftDeviceId: execE2.deviceId,
        leftServices: servicesE2,
        leftConnections: connectionsE2,
        rightDeviceId: authorityA.deviceId,
        rightServices: servicesA,
        rightConnections: connectionsA,
      });
      const linkLegacyA = await connectInMemoryMeshPair({
        leftDeviceId: legacyExecId,
        leftServices: servicesLegacy,
        leftConnections: connectionsLegacy,
        rightDeviceId: authorityA.deviceId,
        rightServices: servicesA,
        rightConnections: connectionsA,
      });

      const executorProgramE1 = createExecutorProgramConversationApplication({
        deviceId: e1MeshDeviceId,
        currentAnchorDeviceId: () => authorityA.deviceId,
        local: { owner: execE1.ownerPort },
        anchorRemote: () =>
          new ProgramConversationMeshClient(() =>
            connectionsE1.client(authorityA.deviceId),
          ),
        isAnchorReachable: () => connectionsE1.has(authorityA.deviceId),
      });

      try {
        // ─── 1. Same 8-char devicePrefix across E1 and E2 ───
        const convOnlyOnE2 = await execE2.createLocalConversation(
          "01JDCX00000000000000000003",
          "仅存在于 E2 的同前缀对话",
        );
        expect(convOnlyOnE2.startsWith(`local-${sharedPrefix}-`)).toBe(true);

        // Initiating `send` & `result` on E1 for `convOnlyOnE2` MUST NOT short-circuit to `not_found` on E1!
        // It forwards E1 -> A -> probes (E1="absent", E2="current") -> dispatches to E2!
        const e1SendRes = await executorProgramE1.send({
          conversationId: convOnlyOnE2,
          requestId: "req-from-e1-to-e2",
          text: "跨同前缀节点命中E2",
        });
        expect(e1SendRes).toMatchObject({
          admitted: true,
          conversationId: convOnlyOnE2,
        });
        const e1ResultOut = await executorProgramE1.result({
          conversationId: convOnlyOnE2,
          requestId: "req-from-e1-to-e2",
          waitMs: 5_000,
        });
        expect(e1ResultOut).toMatchObject({
          state: "completed",
          answer: `exec(${sharedPrefix}):跨同前缀节点命中E2`,
        });
        expect(execE1.admittedCountFor(convOnlyOnE2)).toBe(0);
        expect(execE2.admittedCountFor(convOnlyOnE2)).toBe(1);

        // Both E1 and E2 online and both positively report `"absent"` -> `not_found` (exit 1)!
        const absentSamePrefix = localConversationId(
          e1MeshDeviceId,
          "01JDCX00000000000000000004",
        );
        const absentSend = await hostProgramA.send({
          conversationId: absentSamePrefix,
          requestId: "req-both-absent",
          text: "不存在",
        });
        expect(absentSend).toMatchObject({
          admitted: false,
          error: { code: "not_found" },
        });

        // Disconnect E1 (one same-prefix candidate offline) -> returns `temporarily_unavailable` (exit 3) with ZERO writes on E2!
        await linkE1A.disconnect();
        await expect(
          hostProgramA.send({
            conversationId: convOnlyOnE2,
            requestId: "req-e1-offline-ambiguous",
            text: "候选离线不盲投",
          }),
        ).rejects.toMatchObject({
          code: "temporarily_unavailable",
          options: { exitCode: 3 },
        });
        expect(execE2.admittedCountFor(convOnlyOnE2)).toBe(1);

        // Reconnect E1
        linkE1A = await connectInMemoryMeshPair({
          leftDeviceId: e1MeshDeviceId,
          leftServices: servicesE1,
          leftConnections: connectionsE1,
          rightDeviceId: authorityA.deviceId,
          rightServices: servicesA,
          rightConnections: connectionsA,
        });

        // ─── 2. Cross-Node Internal `conversation` Tool (`discover` & `new`) + Legacy Peer `partial: true` ───
        const remoteCommFromE1 = createMeshConversationCommunication(() =>
          connectionsE1.client(authorityA.deviceId),
        );
        // Extended `discover` with `scope: "all"` hits Anchor + E1 + E2 + LegacyExec (missing service -> partial: true!)
        const extDiscoverAll = (await remoteCommFromE1.invoke("conv-source-e1", {
          action: "discover",
          scope: "all",
          limit: 1,
        })) as {
          conversations: Array<{ conversationId: string }>;
          worksceneCandidates: Array<{ sceneId: string }>;
          nextCursor?: string;
          partial: boolean;
        };
        expect(extDiscoverAll.partial).toBe(true);
        expect(typeof extDiscoverAll.nextCursor).toBe("string");
        expect(extDiscoverAll.worksceneCandidates).toEqual([
          expect.objectContaining({ sceneId: "scene-remote-tool" }),
        ]);

        // Page 2 with `nextCursor` returns `convOnlyOnE2`!
        const extDiscoverPage2 = (await remoteCommFromE1.invoke(
          "conv-source-e1",
          {
            action: "discover",
            scope: "all",
            limit: 5,
            cursor: extDiscoverAll.nextCursor,
          },
        )) as {
          conversations: Array<{ conversationId: string }>;
          partial: boolean;
        };
        expect(extDiscoverPage2.partial).toBe(true);
        expect(
          extDiscoverPage2.conversations.map((c) => c.conversationId),
        ).toContain(convOnlyOnE2);

        // Cross-node internal `new` creates workscene primary conversation idempotently on Anchor under `conversation:conv-source-e1`
        const remoteCreated1 = (await remoteCommFromE1.invoke("conv-source-e1", {
          action: "new",
          operationId: "op-remote-ws-1",
          sceneId: "scene-remote-tool",
        })) as { conversationId: string; created: boolean };
        expect(remoteCreated1).toMatchObject({
          conversationId: "ws:scene-remote-tool:primary",
          created: true,
        });
        const remoteCreatedReplay = (await remoteCommFromE1.invoke(
          "conv-source-e1",
          {
            action: "new",
            operationId: "op-remote-ws-1",
            sceneId: "scene-remote-tool",
          },
        )) as { conversationId: string; created: boolean };
        expect(remoteCreatedReplay).toMatchObject({
          conversationId: "ws:scene-remote-tool:primary",
          created: true,
        });

        // Inbound `new` sent to non-Anchor E1 is rejected with zero writes!
        const commAToE1 = createMeshConversationCommunication(() =>
          connectionsA.client(e1MeshDeviceId),
        );
        await expect(
          commAToE1.invoke("default", {
            action: "new",
            operationId: "illegal-new-to-e1",
            name: "非法新建",
          }),
        ).rejects.toThrow(/仅当值主控节点可受理/);

        // ─── 3. Cross-Version Skew: `incompatible-version` vs `service-unavailable` ───
        // 3a. Legacy executor (`bbbbbbbb-...`) is connected WITHOUT `conversation.program` (`service-unavailable`) ->
        // Cross-hop `send` preserves ticket and exits 3 (never misreporting as un-written exit 1)!
        const legacyLocalConv = localConversationId(
          legacyExecId,
          "01JDCX00000000000000000005",
        );
        const localAnchorHandle = async (): Promise<ProgramConversationClientHandle> => ({
          facade: {
            ensureConnected: async () => {},
            list: (i, s) => hostProgramA.list(i, s),
            create: (i, s) => hostProgramA.create(i, s),
            read: (i, s) => hostProgramA.read(i, s),
            send: (i, s) => hostProgramA.send(i, s),
            result: (i, s) => hostProgramA.result(i, s),
          },
          dispose: async () => {},
        });
        const svcUnavailCap = captureCliIO({
          zhixingHome: homeCli,
          openClient: localAnchorHandle,
        });
        expect(
          await runConversationSendCommand(
            legacyLocalConv,
            { text: "跨跳服务未注册保票", id: "req-svc-unavail", json: true },
            svcUnavailCap.io,
          ),
        ).toBe(3);
        expect(JSON.parse(svcUnavailCap.stdoutText)).toMatchObject({
          requestId: "req-svc-unavail",
        });

        // 3b. `incompatible-version` (`compatibility.mode === "read-only"`):
        // Reconnect LegacyExec WITH `conversation.program` registered, but negotiated in `read-only` skew mode!
        await linkLegacyA.disconnect();
        registerProgramConversationMeshService({
          registry: servicesLegacy,
          isActiveMember,
          peerHasRole,
          isCurrentAnchor: () => false,
          currentAnchorDeviceId: () => authorityA.deviceId,
          localOwned: () => {
            throw new ProgramConversationError(
              "invalid_params",
              "must never reach handler in read-only skew mode",
              { retryable: false, exitCode: 1 },
            );
          },
        });
        const skewLink = await connectInMemoryMeshPair({
          leftDeviceId: legacyExecId,
          leftServices: servicesLegacy,
          leftConnections: connectionsLegacy,
          rightDeviceId: authorityA.deviceId,
          rightServices: servicesA,
          rightConnections: connectionsA,
          compatibility: { mode: "read-only", reason: "incompatible-version" },
        });
        try {
          // Brand-new `send` (no `--id`, confirmed un-written before frame delivery) -> exit 1 (`unsupported_host_version`, `admitted: false`)!
          const skewBrandNewCap = captureCliIO({
            zhixingHome: homeCli,
            openClient: localAnchorHandle,
          });
          expect(
            await runConversationSendCommand(
              legacyLocalConv,
              { text: "版本偏斜确证未写入", json: true },
              skewBrandNewCap.io,
            ),
          ).toBe(1);
          expect(JSON.parse(skewBrandNewCap.stdoutText)).toMatchObject({
            admitted: false,
            error: { code: "unsupported_host_version", retryable: false },
          });

          // Explicit `--id` replay or `result <ticket>` (`priorAcceptancePossible`) -> exit 3 (preserves ticket, never falsely denies prior acceptance)!
          const skewReplayCap = captureCliIO({
            zhixingHome: homeCli,
            openClient: localAnchorHandle,
          });
          expect(
            await runConversationSendCommand(
              legacyLocalConv,
              {
                text: "可能既往已接纳重放",
                id: "req-prior-before-downgrade",
                json: true,
              },
              skewReplayCap.io,
            ),
          ).toBe(3);
          const skewReplayJson = JSON.parse(skewReplayCap.stdoutText);
          expect(skewReplayJson.ticket.startsWith("zxt1.")).toBe(true);
          expect(skewReplayJson.error.code).toBe("unsupported_host_version");

          const skewResultCap = captureCliIO({
            zhixingHome: homeCli,
            openClient: localAnchorHandle,
          });
          expect(
            await runConversationResultCommand(
              skewReplayJson.ticket,
              { json: true },
              skewResultCap.io,
            ),
          ).toBe(3);
          expect(JSON.parse(skewResultCap.stdoutText)).toMatchObject({
            state: "temporarily_unavailable",
            error: { code: "unsupported_host_version", retryable: false },
          });
        } finally {
          await skewLink.disconnect();
        }
      } finally {
        await linkLegacyA.disconnect();
        await linkE2A.disconnect();
        await linkE1A.disconnect();
        await execE2.close();
        await execE1.close();
        await protocolA.stopRecoveryLoop();
        await managerA.disposeAll();
        await authorityA.stopStorageMaintenance();
      }
    },
    TEST_DURABLE_IO_TIMEOUT_MS,
  );
});
