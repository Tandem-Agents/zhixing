import type { SecretStorePort } from "@zhixing/core/contracts";
import { DeviceLifecycleJournal } from "@zhixing/core/authority";
import { protocolDigest, type ProtocolSignatureVerifier } from "@zhixing/core/protocol";
import type { StorageMaintenanceGovernorPort } from "@zhixing/core/resources";
import { currentAndPreviousTerminalRendezvousKeys } from "@zhixing/mesh/bootstrap";
import type { DeviceKey } from "@zhixing/mesh/device-identity";
import { deleteDeviceKeyExact } from "@zhixing/mesh/device-key-store";
import { connectAuthenticatedMesh } from "@zhixing/mesh/handshake";
import { MeshRequestChannel } from "@zhixing/mesh/request-channel";
import { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import type { SecureMeshConnection } from "@zhixing/mesh/transport";
import { cleanupExecutorDeviceLocalState } from "./device-removal-cleanup.js";
import { DeviceRemovalIssuerMeshClient } from "./device-removal-mesh.js";
import {
  ExecutorRemovalTarget,
  type ExecutorRemovalTerminalRecovery,
} from "./device-removal.js";
import { createManagedServiceAdapter } from "./managed-service.js";
import { loadCurrentManagedServiceState } from "./managed-service-runtime.js";
import { openRelaySocket } from "./mesh-control-plane.js";
import type { ExecutorRemovalRetrievalBootstrap } from "./mesh-runtime-bootstrap.js";

const PROTOCOL_RANGE = { min: "1", max: "1" } as const;
const INITIAL_RETRY_MS = 250;
const MAX_RETRY_MS = 30_000;

/**
 * 撤销之后取回终态：用 accept 时冻结的恢复材料经 issuer 的终态入口连接（先直连、再中继），
 * 握手 SNI 携带本操作的定位；只调用终态 exact-set，issuer 按已存事实幂等重算回执。
 * 失败按退避重试，不设 TTL，直到本机写下 terminal 或被停止。
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
  ) => Promise<SecureMeshConnection>;
  readonly random?: () => number;
}): Promise<void> {
  const open = input.open ?? ((recovery, signal) =>
    openExecutorRemovalTerminalConnection(recovery, input.deviceKey, signal));
  const random = input.random ?? Math.random;
  let failures = 0;
  while (!input.signal.aborted) {
    if (await input.target.isRetired(input.operationId)) return;
    try {
      // 已耐久 issuer 终态回执时只做本机收尾，不联网
      if (await input.target.finishFromDurableTerminal(input.operationId)) return;
      const recovery = await input.target.terminalRecovery(input.operationId);
      const connection = await open(recovery, input.signal);
      const channel = new MeshRequestChannel(connection, new MeshServiceRegistry());
      // 停止要取消在等的请求并回收这条连接；握手阶段已由 open 的 signal 取消。
      // 本机已开始的收尾步骤照常走完，下一次请求时因通道已关而退出。
      const stop = () => {
        void channel.close(new Error("Device removal retrieval stopped")).catch(() => undefined);
      };
      input.signal.addEventListener("abort", stop, { once: true });
      try {
        if (input.signal.aborted) throw new Error("Device removal retrieval stopped");
        await input.target.resumeWithIssuer(new DeviceRemovalIssuerMeshClient(channel, input.verifier));
      } finally {
        input.signal.removeEventListener("abort", stop);
        await channel.close().catch(() => undefined);
      }
      if (await input.target.isRetired(input.operationId)) return;
      failures += 1;
    } catch (error) {
      if (input.signal.aborted) return;
      failures += 1;
      input.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
    const cap = Math.min(MAX_RETRY_MS, INITIAL_RETRY_MS * 2 ** Math.max(0, failures - 1));
    await delay(Math.floor(cap * random()), input.signal);
  }
}

/**
 * 运行中进程的专用取回 owner：本机移除进入撤销阶段后，内联续做中断（成员连接断开、回执丢失）
 * 或成员连接上发现未终结的撤销阶段移除时接手。至多一个在跑；停止即取消；不开放普通业务准入
 * （移除的准入闸自 gate-frozen 起一直关闭）。
 */
export class ExecutorRemovalRetrievalOwner {
  #running: { readonly operationId: string; readonly controller: AbortController; readonly done: Promise<void> } | undefined;
  #stopped = false;

  constructor(private readonly options: {
    readonly target: () => ExecutorRemovalTarget;
    readonly deviceKey: DeviceKey;
    readonly verifier: ProtocolSignatureVerifier;
    readonly onError?: (error: Error) => void;
    readonly open?: Parameters<typeof retrieveExecutorRemovalTerminal>[0]["open"];
  }) {}

  /** 已有同一操作的 owner 时不重复启动；停止后不再接手。 */
  schedule(operationId: string): void {
    if (this.#stopped || this.#running) return;
    const controller = new AbortController();
    const done = retrieveExecutorRemovalTerminal({
      target: this.options.target(),
      deviceKey: this.options.deviceKey,
      verifier: this.options.verifier,
      operationId,
      signal: controller.signal,
      ...(this.options.onError ? { onError: this.options.onError } : {}),
      ...(this.options.open ? { open: this.options.open } : {}),
    }).catch((error: unknown) => {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }).finally(() => {
      if (this.#running?.controller === controller) this.#running = undefined;
    });
    this.#running = { operationId, controller, done };
  }

  get running(): string | undefined {
    return this.#running?.operationId;
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
