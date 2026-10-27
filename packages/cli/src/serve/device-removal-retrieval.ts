import type { HomeTrustEvent, SecretStorePort } from "@zhixing/core/contracts";
import { DeviceLifecycleJournal } from "@zhixing/core/authority";
import { protocolDigest, type ExecutorRemovalSuccessor, type ProtocolSignatureVerifier } from "@zhixing/core/protocol";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import {
  currentAndPreviousDiscoveryRendezvousKeys,
  currentAndPreviousTerminalRendezvousKeys,
} from "@zhixing/mesh/bootstrap";
import {
  HomeDiscoveryRefusedError,
  openHomeDiscovery,
  type HomeDiscoveryClientSession,
  type HomeDiscoveryLocalChain,
  type HomeDiscoveryResumePoint,
} from "@zhixing/mesh/home-discovery";
import type { DeviceKey } from "@zhixing/mesh/device-identity";
import { deleteDeviceKeyExact } from "@zhixing/mesh/device-key-store";
import { connectAuthenticatedMesh } from "@zhixing/mesh/handshake";
import { MeshRequestChannel } from "@zhixing/mesh/request-channel";
import { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import type { SecureMeshConnection } from "@zhixing/mesh/transport";
import { cleanupExecutorDeviceLocalState } from "./device-removal-cleanup.js";
import {
  readDiscoveryProgress,
  recordDiscoveryProgress,
  resumePointOf,
  type DiscoveryProgressLog,
} from "./discovery-progress.js";
import { DeviceRemovalIssuerMeshClient } from "./device-removal-mesh.js";
import {
  createExecutorRemovalRecoveryEvidence,
  ExecutorRemovalTarget,
  isExecutorRemovalDomainState,
  successorReceiptVerifier,
  type ExecutorRemovalDomainState,
  type ExecutorRemovalTerminalRecovery,
} from "./device-removal.js";
import { createManagedServiceAdapter } from "./managed-service.js";
import { loadCurrentManagedServiceState } from "./managed-service-runtime.js";
import { openRelaySocket } from "./mesh-control-plane.js";
import type { ExecutorRemovalRetrievalBootstrap } from "./mesh-runtime-bootstrap.js";

const PROTOCOL_RANGE = { min: "1", max: "1" } as const;
const INITIAL_RETRY_MS = 250;
const MAX_RETRY_MS = 30_000;

/** 已验明的现任对本次移除给出的领域结论：不是网络错误，不再退避重试。 */
export class ExecutorRemovalDomainStateError extends Error {
  constructor(readonly state: ExecutorRemovalDomainState) {
    super(`The current duty device reports this removal as ${state}`);
    this.name = "ExecutorRemovalDomainStateError";
  }
}

/** 一次取回的结果：已退休、现任给出领域结论、或被停止。 */
export type ExecutorRemovalRetrievalResult =
  | { readonly kind: "retired" }
  | { readonly kind: "domain-state"; readonly state: ExecutorRemovalDomainState }
  | { readonly kind: "stopped" };

/** 一次终态连接：经原 issuer 时没有继任上下文；经发现找到现任时带上已验明的现任 issuer。 */
export interface ExecutorRemovalTerminalSession {
  readonly connection: SecureMeshConnection;
  readonly successor?: ExecutorRemovalSuccessor;
}

/**
 * 撤销之后取回终态：用 accept 时冻结的恢复材料经 issuer 的终态入口连接（先直连、再中继），
 * 握手 SNI 携带本操作的定位；只调用终态 exact-set，issuer 按已存事实幂等重算回执。
 * 失败按退避重试，不设 TTL，直到本机写下 terminal 或被停止；已验明的现任给出领域结论时停止并返回该结论。
 */
export async function retrieveExecutorRemovalTerminal(input: {
  readonly target: ExecutorRemovalTarget;
  readonly deviceKey: DeviceKey;
  readonly verifier: ProtocolSignatureVerifier;
  readonly operationId: string;
  readonly signal: AbortSignal;
  readonly onError?: (error: Error) => void;
  readonly open?: (
    recovery: ExecutorRemovalTerminalRecovery,
    signal: AbortSignal,
  ) => Promise<SecureMeshConnection | ExecutorRemovalTerminalSession>;
  /** 本机信任链端口：原 issuer 不在时据此验证现任的继任证明（按键读所需的点）。没有时只走原 issuer。 */
  readonly localChain?: () => Promise<HomeDiscoveryLocalChain | undefined>;
  /** 终态发现的已验证进度耐久处（本机权威日志）；没有时进度只在本次取回里保留。 */
  readonly discoveryProgress?: DiscoveryProgressLog;
  readonly random?: () => number;
}): Promise<ExecutorRemovalRetrievalResult> {
  const open = input.open ?? ((recovery, signal) =>
    openExecutorRemovalTerminalSession(recovery, input.deviceKey, signal, input.localChain, input.discoveryProgress));
  const random = input.random ?? Math.random;
  let failures = 0;
  while (!input.signal.aborted) {
    if (await input.target.isRetired(input.operationId)) return { kind: "retired" };
    try {
      // 已耐久 issuer 终态回执时只做本机收尾，不联网
      if (await input.target.finishFromDurableTerminal(input.operationId)) return { kind: "retired" };
      const recovery = await input.target.terminalRecovery(input.operationId);
      const opened = await open(recovery, input.signal);
      const session: ExecutorRemovalTerminalSession = "peer" in opened ? { connection: opened } : opened;
      const channel = new MeshRequestChannel(session.connection, new MeshServiceRegistry());
      const verifier = session.successor ? successorReceiptVerifier(input.verifier, session.successor) : input.verifier;
      // 停止要取消在等的请求并回收这条连接；握手阶段已由 open 的 signal 取消。
      // 本机已开始的收尾步骤照常走完，下一次请求时因通道已关而退出。
      const stop = () => {
        void channel.close(new Error("Device removal retrieval stopped")).catch(() => undefined);
      };
      input.signal.addEventListener("abort", stop, { once: true });
      try {
        if (input.signal.aborted) throw new Error("Device removal retrieval stopped");
        await input.target.resumeWithIssuer(new DeviceRemovalIssuerMeshClient(channel, verifier), session.successor);
      } finally {
        input.signal.removeEventListener("abort", stop);
        await channel.close().catch(() => undefined);
      }
      if (await input.target.isRetired(input.operationId)) return { kind: "retired" };
      failures += 1;
    } catch (error) {
      if (input.signal.aborted) return { kind: "stopped" };
      input.onError?.(error instanceof Error ? error : new Error(String(error)));
      if (error instanceof ExecutorRemovalDomainStateError) return { kind: "domain-state", state: error.state };
      failures += 1;
    }
    const cap = Math.min(MAX_RETRY_MS, INITIAL_RETRY_MS * 2 ** Math.max(0, failures - 1));
    await delay(Math.floor(cap * random()), input.signal);
  }
  return { kind: "stopped" };
}

/**
 * 运行中进程的专用取回 owner：本机移除进入撤销阶段后，内联续做中断（成员连接断开、回执丢失）
 * 或成员连接上发现未终结的撤销阶段移除时接手。至多一个在跑；停止即取消；不开放普通业务准入
 * （移除的准入闸自 gate-frozen 起一直关闭）。
 */
export class ExecutorRemovalRetrievalOwner {
  #running: { readonly operationId: string; readonly controller: AbortController; readonly done: Promise<void> } | undefined;
  /** 现任给出的领域结论：本进程内不再为该操作重启取回，供上层呈现。 */
  readonly #domainStates = new Map<string, ExecutorRemovalDomainState>();
  #stopped = false;

  constructor(private readonly options: {
    readonly target: () => ExecutorRemovalTarget;
    readonly deviceKey: DeviceKey;
    readonly verifier: ProtocolSignatureVerifier;
    readonly onError?: (error: Error) => void;
    readonly open?: Parameters<typeof retrieveExecutorRemovalTerminal>[0]["open"];
    readonly localChain?: () => Promise<HomeDiscoveryLocalChain | undefined>;
    readonly discoveryProgress?: DiscoveryProgressLog;
  }) {}

  /** 已有同一操作的 owner 时不重复启动；停止后不再接手。 */
  schedule(operationId: string): void {
    if (this.#stopped || this.#running || this.#domainStates.has(operationId)) return;
    const controller = new AbortController();
    const done = retrieveExecutorRemovalTerminal({
      target: this.options.target(),
      deviceKey: this.options.deviceKey,
      verifier: this.options.verifier,
      operationId,
      signal: controller.signal,
      ...(this.options.onError ? { onError: this.options.onError } : {}),
      ...(this.options.open ? { open: this.options.open } : {}),
      ...(this.options.localChain ? { localChain: this.options.localChain } : {}),
      ...(this.options.discoveryProgress ? { discoveryProgress: this.options.discoveryProgress } : {}),
    }).then((result) => {
      if (result.kind === "domain-state") this.#domainStates.set(operationId, result.state);
    }, (error: unknown) => {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }).finally(() => {
      if (this.#running?.controller === controller) this.#running = undefined;
    });
    this.#running = { operationId, controller, done };
  }

  get running(): string | undefined {
    return this.#running?.operationId;
  }

  /** 现任对该操作给出的领域结论（没有则 undefined）。 */
  domainState(operationId: string): ExecutorRemovalDomainState | undefined {
    return this.#domainStates.get(operationId);
  }

  /** 等当前 owner 跑完或被取消；仅供停止与测试使用。 */
  async settled(): Promise<void> {
    await this.#running?.done;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    const running = this.#running;
    running?.controller.abort(new Error("Device removal retrieval stopped"));
    await running?.done;
  }
}

/**
 * 恢复顺序：先按冻结的原 issuer 身份与端点连终态入口；原 issuer 不可达或已不值班时，按冻结端点里的中继做
 * 终态发现——先验现任的继任证明（含灾备提交证明与分叉规则），再出示恢复证据，最后在同一连接上进入终态入口。
 * 后缀超出单次会话预算时连续开会话：已验证进度耐久后从它接着，直到拿到完整证明；进度不改本机信任视图。
 */
export async function openExecutorRemovalTerminalSession(
  recovery: ExecutorRemovalTerminalRecovery,
  deviceKey: DeviceKey,
  signal: AbortSignal,
  localChain?: () => Promise<HomeDiscoveryLocalChain | undefined>,
  progressLog?: DiscoveryProgressLog,
): Promise<ExecutorRemovalTerminalSession> {
  try {
    return { connection: await openExecutorRemovalTerminalConnection(recovery, deviceKey, signal) };
  } catch (frozen) {
    if (!localChain || signal.aborted) throw frozen;
    const local = await localChain();
    if (!local) throw frozen;
    const failures: Error[] = [frozen instanceof Error ? frozen : new Error(String(frozen))];
    const localHead = local.head;
    const homeId = recovery.identity.homeId;
    let inMemory: HomeDiscoveryResumePoint | undefined;
    const loadResume = async () => {
      if (!progressLog) return inMemory;
      const stored = await readDiscoveryProgress(progressLog, { purpose: "terminal", homeId, localHead });
      return stored ? resumePointOf(stored) : undefined;
    };
    for (const transport of recovery.endpoint.transports) {
      if (transport.kind !== "blind-relay") continue;
      for (const key of currentAndPreviousDiscoveryRendezvousKeys(recovery.secret, "terminal")) {
        try {
          let discovery: HomeDiscoveryClientSession;
          for (let reached = -1; ;) {
            const resume = await loadResume();
            const socket = await openRelaySocket(transport.relay, key, "connect", signal);
            discovery = await openHomeDiscovery({
              socket, purpose: "terminal", secret: recovery.secret, local, ...(resume ? { resume } : {}), signal,
            });
            const verified = discovery.verified;
            if (verified.complete) break;
            if (verified.projection.chainHead.seq <= reached) throw new Error("Home discovery made no progress");
            reached = verified.projection.chainHead.seq;
            inMemory = {
              point: verified.projection.chainHead,
              projection: verified.projection,
              ...(verified.ancestor ? { ancestor: verified.ancestor } : {}),
            };
            if (progressLog) {
              await recordDiscoveryProgress(progressLog, { purpose: "terminal", homeId, localHead, ...inMemory });
            }
          }
          const verified = discovery.verified;
          if (!verified.complete) throw new Error("Home discovery did not complete");
          try {
            const { projection, issuer, transcript } = verified;
            // 现任链在接受点之前分叉：附上本机链上公共祖先之后到接受点的原签名事件，供现任验接受时的授权
            const ancestor = verified.ancestor;
            const forkSegment = ancestor ? await acceptedForkSegment(local, ancestor, recovery.identity.acceptedTrustHeadDigest) : undefined;
            try {
              await discovery.sendEvidence(createExecutorRemovalRecoveryEvidence({
                transcript,
                recovery,
                deviceKey,
                ...(forkSegment ? { forkSegment } : {}),
              }));
            } catch (error) {
              // 已验明的现任给出的领域结论：不是网络错误，不再换路或退避重试
              if (error instanceof HomeDiscoveryRefusedError && isExecutorRemovalDomainState(error.reason)) {
                throw new ExecutorRemovalDomainStateError(error.reason);
              }
              throw error;
            }
            const upgraded = await discovery.upgrade();
            const connection = await connectAuthenticatedMesh({
              socket: upgraded,
              trustedPeer: issuer,
              identity: deviceKey,
              protocolRange: PROTOCOL_RANGE,
              locator: recovery.locator,
              authorizePeer: (identity: { readonly deviceId: string }) => identity.deviceId === issuer.identity.deviceId,
              signal,
            });
            if (projection.issuer.issuerKeyId === recovery.identity.acceptedIssuerKeyId) return { connection };
            const issuerPublicKey = projection.issuer.issuerPublicKey ?? issuer.identity.publicKey;
            return {
              connection,
              successor: Object.freeze({
                issuerDeviceId: projection.issuer.deviceId,
                issuerKeyId: projection.issuer.issuerKeyId,
                issuerPublicKey,
                anchorEpoch: projection.anchorEpoch,
              }),
            };
          } catch (error) {
            discovery.close();
            throw error;
          }
        } catch (error) {
          if (error instanceof ExecutorRemovalDomainStateError) throw error;
          failures.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
    throw new AggregateError(failures, "Neither the accepting duty device nor its successor is reachable");
  }
}

/** 接受点在公共祖先之后时：按摘要定位接受点，只读（祖先, 接受点]这段本机原签名事件。 */
async function acceptedForkSegment(
  local: HomeDiscoveryLocalChain,
  ancestor: { readonly seq: number; readonly eventDigest: string },
  acceptedTrustHeadDigest: string,
): Promise<{ readonly ancestor: typeof ancestor; readonly events: readonly HomeTrustEvent[] } | undefined> {
  const accepted = await local.eventByDigest(acceptedTrustHeadDigest);
  if (!accepted || accepted.seq <= ancestor.seq) return undefined;
  const events: HomeTrustEvent[] = [];
  for (let seq = ancestor.seq + 1; seq <= accepted.seq; seq++) {
    const event = await local.eventAt(seq);
    if (!event) throw new Error("Local trust chain is missing part of the accepted fork segment");
    events.push(event);
  }
  return { ancestor, events };
}

/** 按 issuer 端点依次尝试直连与中继终态入口；中继以 connect 角色会合，身份由端到端握手保证。 */
export async function openExecutorRemovalTerminalConnection(
  recovery: ExecutorRemovalTerminalRecovery,
  deviceKey: DeviceKey,
  signal: AbortSignal,
): Promise<SecureMeshConnection> {
  const failures: Error[] = [];
  const common = {
    trustedPeer: recovery.issuer,
    identity: deviceKey,
    protocolRange: PROTOCOL_RANGE,
    locator: recovery.locator,
    authorizePeer: (identity: { readonly deviceId: string }) =>
      identity.deviceId === recovery.issuer.identity.deviceId,
    signal,
  };
  const ordered = [
    ...recovery.endpoint.transports.filter((transport) => transport.kind === "direct"),
    ...recovery.endpoint.transports.filter((transport) => transport.kind === "blind-relay"),
  ];
  for (const transport of ordered) {
    try {
      if (transport.kind === "direct") {
        return await connectAuthenticatedMesh({ ...common, host: transport.host, port: transport.port });
      }
      for (const key of currentAndPreviousTerminalRendezvousKeys(recovery.secret)) {
        try {
          const socket = await openRelaySocket(transport.relay, key, "connect", signal);
          return await connectAuthenticatedMesh({ ...common, socket });
        } catch (error) {
          failures.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  throw new AggregateError(failures, "The duty device's terminal entry is unreachable");
}

/**
 * 宿主在 bootstrap 返回专用取回时运行它：只装撤销之后的本机效果（清理、精确删钥），
 * 不恢复普通业务准入；本机 terminal 写下后返回，由宿主重新走启动的退休路径。
 */
export async function runExecutorRemovalRetrieval(input: {
  readonly mesh: ExecutorRemovalRetrievalBootstrap;
  readonly secretStore: SecretStorePort;
  readonly zhixingHome: string;
  readonly storageGovernor?: StorageMaintenanceGovernorPort;
  readonly signal?: AbortSignal;
  readonly onError?: (error: Error) => void;
}): Promise<void> {
  const { mesh } = input;
  const log = mesh.bootstrapStore.authorityLog();
  const operation = await new DeviceLifecycleJournal(log, mesh.verifier).state(mesh.operationId);
  if (!operation || operation.identity.kind !== "executor-removal") {
    throw new Error("Device removal retrieval has no durable removal");
  }
  const identity = operation.identity;
  const unavailable = async (): Promise<never> => {
    throw new Error("Device removal retrieval only resumes effects after revocation");
  };
  const target = new ExecutorRemovalTarget({
    log,
    homeId: identity.homeId,
    deviceKey: mesh.deviceKey,
    verifier: mesh.verifier,
    secretStore: input.secretStore,
    issuerRoute: unavailable,
    closeAdmission: unavailable,
    settleAcceptedWork: unavailable,
    releaseAdmission: async () => undefined,
    transferToAnchor: unavailable,
    cleanup: async () => {
      const current = await loadCurrentManagedServiceState("activate", input.zhixingHome, input.secretStore);
      const adapter = current.spec
        ? createManagedServiceAdapter({ storageGovernor: input.storageGovernor })
        : undefined;
      const expected = current.spec
        ? await adapter!.inspect(current.spec, new AbortController().signal)
        : undefined;
      return cleanupExecutorDeviceLocalState({
        zhixingHome: input.zhixingHome,
        secretStore: input.secretStore,
        deviceKey: mesh.deviceKey,
        storageGovernor: input.storageGovernor,
        disasterRecoveryStaging: mesh.disasterRecoveryStaging,
        unregisterFuture: async () => {
          if (!current.spec || !adapter || !expected) return;
          await adapter.unregisterFutureExact(current.spec, expected, new AbortController().signal);
        },
      });
    },
    finalizeDeviceKey: async (operationId, frozen) => {
      const generation = protocolDigest("DeviceKeyGeneration", 1, {
        deviceId: mesh.deviceKey.deviceId,
        publicKey: mesh.deviceKey.publicKey,
      });
      if (frozen.targetDeviceId !== mesh.deviceKey.deviceId || frozen.targetDeviceKeyGeneration !== generation) {
        throw new Error("Device removal key finalizer does not own the frozen key generation");
      }
      await deleteDeviceKeyExact(input.secretStore, mesh.deviceKey);
      return [{
        kind: "cleanup" as const,
        digest: protocolDigest("ExecutorRemovalDeviceKeyDeleted", 1, {
          operationId,
          targetDeviceId: frozen.targetDeviceId,
          targetDeviceKeyGeneration: frozen.targetDeviceKeyGeneration,
        }),
      }];
    },
  });
  await retrieveExecutorRemovalTerminal({
    target,
    deviceKey: mesh.deviceKey,
    verifier: mesh.verifier,
    operationId: mesh.operationId,
    localChain: () => mesh.bootstrapStore.discoveryLocalChain(),
    discoveryProgress: mesh.bootstrapStore.authorityLog(),
    signal: input.signal ?? new AbortController().signal,
    ...(input.onError ? { onError: input.onError } : {}),
  });
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
