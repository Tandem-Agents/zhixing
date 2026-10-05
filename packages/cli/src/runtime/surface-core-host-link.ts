import { randomUUID } from "node:crypto";
import type { RpcEncodedJsonSource, RpcRequestDeadline } from '@zhixing/server/client';

import type { HomeTrustRecord } from "@zhixing/core/contracts";
import { canonicalize } from "@zhixing/core/protocol";
import { validateMeshRoleBootConfig } from "@zhixing/mesh/bootstrap";
import { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import { createPlatformSecretStore } from "@zhixing/secrets";
import {
  PROTOCOL_VERSION,
  RpcAppError,
  RpcClientClosedError,
  type AuthResult,
  type RpcClient,
} from "@zhixing/server";
import { ZHIXING_CLI_VERSION } from "../version.js";
import {
  FirstPartyConversationMeshClient,
  isCurrentAnchorRelayMethod,
  type FirstPartyIngressConnection,
} from "../serve/first-party-conversation-mesh.js";
import { FileMeshBootstrapStore } from "../serve/mesh-bootstrap-store.js";
import { createMeshBootstrapProjectionPorts } from "../serve/mesh-bootstrap-projection.js";
import { ProductionMeshControlPlane } from "../serve/mesh-control-plane.js";
import { loadExistingDeviceKey } from "../serve/mesh-device-key.js";
import { CoreHostUnavailableError } from "./core-host-connection.js";
import {
  createRuntimeConfigurationProvider,
  type RuntimeConfigurationProvider,
} from "./runtime-configuration-provider.js";

type NotificationHandler = (params: unknown) => void;
type WildcardNotificationHandler = (method: string, params: unknown) => void;
let nextSurfaceConnectionId = 1;

interface SurfaceBinding {
  readonly ownerDeviceId: string;
  readonly ownerIdentity: string;
  readonly connection: FirstPartyIngressConnection;
  readonly remote: FirstPartyConversationMeshClient;
  readonly closeHandlers: Set<() => void>;
  closed: boolean;
}

export async function createCurrentAnchorSurfaceRpcClient(options: {
  readonly zhixingHome: string;
  readonly configuration?: Pick<RuntimeConfigurationProvider, "readTopology">;
  readonly secretStore?: ReturnType<typeof createPlatformSecretStore>;
}): Promise<CurrentAnchorSurfaceRpcClient> {
  const homeDir = options.zhixingHome;
  const configuration = (
    options.configuration ?? createRuntimeConfigurationProvider()
  ).readTopology({ homeDir }).mesh;
  if (!configuration) throw new CoreHostUnavailableError("这台设备尚未完成家庭配置");
  const secretStore = options.secretStore ?? createPlatformSecretStore({ homeDir, context: "foreground" });
  if (await secretStore.unlockState() !== "unlocked") {
    throw new CoreHostUnavailableError("请先解锁本机凭据");
  }
  const deviceKey = await loadExistingDeviceKey(secretStore);
  if (!deviceKey) throw new CoreHostUnavailableError("这台设备尚未完成配对");
  const bootstrapStore = new FileMeshBootstrapStore(homeDir, deviceKey);
  const bootstrapProjection = createMeshBootstrapProjectionPorts(bootstrapStore);
  const trust = await bootstrapStore.loadTrustRecord();
  if (!trust) {
    await bootstrapStore.stopStorageMaintenance();
    throw new CoreHostUnavailableError("这台设备尚未完成配对");
  }
  const local = trust.members.find((member) => member.device.deviceId === deviceKey.deviceId);
  if (!local || local.state !== "active") {
    await bootstrapStore.stopStorageMaintenance();
    throw new CoreHostUnavailableError("这台设备已不在当前家庭中");
  }
  try {
    const services = new MeshServiceRegistry();
    let client: CurrentAnchorSurfaceRpcClient | undefined;
    const control = new ProductionMeshControlPlane({
      localIdentity: deviceKey,
      trust,
      configuration: validateMeshRoleBootConfig(configuration),
      endpoints: await bootstrapProjection.endpoints.loadEndpoints(),
      transportPeers: await bootstrapProjection.transportPeers.loadTransportPeers(),
      secretStore,
      endpointDirectory: bootstrapProjection.endpoints,
      transportPeerDirectory: bootstrapProjection.transportPeers,
      trustProjection: Object.freeze({
        loadTrustRecord: () => bootstrapStore.loadTrustRecord(),
      }),
      services,
      onTrustReconciled: (record) => client?.reconcileOwner(record),
    });
    client = new CurrentAnchorSurfaceRpcClient(deviceKey.deviceId, control, bootstrapStore);
    return client;
  } catch (error) {
    await bootstrapStore.stopStorageMaintenance();
    throw error;
  }
}

export class CurrentAnchorSurfaceRpcClient implements RpcClient {
  readonly #methodHandlers = new Map<string, Set<NotificationHandler>>();
  readonly #wildcardHandlers = new Set<WildcardNotificationHandler>();
  readonly #closeHandlers = new Set<() => void>();
  readonly #turnoverHandlers = new Set<() => void>();
  readonly #surfacePrincipal = `rpc:${randomUUID()}`;
  readonly #retiring = new Set<Promise<void>>();
  #binding: SurfaceBinding | undefined;
  #surfaceGeneration = 0;
  #started = false;
  #closed = false;
  #closing: Promise<void> | undefined;
  #preparing?: Promise<unknown>;
  #preparationAbort?: AbortController;
  #drainDeadline = 0;
  readonly #requests = new Set<Promise<unknown>>();

  constructor(
    private readonly sourceDeviceId: string,
    private readonly control: Pick<
      ProductionMeshControlPlane,
      "start" | "stop" | "currentTrust" | "connections"
    >,
    private readonly bootstrapStore: {
      readonly stopStorageMaintenance: () => Promise<void>;
    },
  ) {}

  get closed(): boolean { return this.#closed; }
  get drainDeadline(): number { return this.#drainDeadline; }
  async drain(): Promise<void> {
    await Promise.allSettled([this.#preparing, ...this.#requests]);
    await new Promise<void>(resolve => setImmediate(resolve));
  }

  maximumRequestSourceBytes(method: string): number {
    const binding = this.#currentBinding(method);
    return binding.remote.dispatchParamsByteLimit(method, binding.connection);
  }

  async prepareRequestSource<T extends RpcEncodedJsonSource | undefined>(prepare: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<{ source: T; deadline: number }> {
    if (this.#closed || this.#preparing || signal?.aborted) throw Error('远端输入准备不可用；草稿已保留。');
    const deadline = this.#drainDeadline = Date.now() + 30_000;
    const abort = new AbortController(); this.#preparationAbort = abort;
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, deadline - Date.now());
    // This source is capped to the existing <=1 MiB service envelope. It never
    // borrows the local 100 MiB receive workspace or expands the Mesh protocol.
    const work = Promise.resolve().then(() => prepare(abort.signal));
    this.#preparing = work;
    try {
      const source = await work; abort.signal.throwIfAborted();
      return { source, deadline };
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      await new Promise<void>(resolve => setImmediate(resolve));
      this.#preparing = undefined; this.#preparationAbort = undefined;
    }
  }

  async requestEncoded<T>(method: string, source: RpcEncodedJsonSource, options?: Partial<RpcRequestDeadline>): Promise<T> {
    await this.drain();
    const binding = this.#currentBinding(method);
    if (source.byteLength > binding.remote.dispatchParamsByteLimit(method, binding.connection)) throw Error('远端请求超过现有消息容量，草稿已保留。');
    const abort = new AbortController();
    const deadline = options?.deadline ?? Date.now() + 30_000;
    if (deadline <= Date.now() || options?.signal?.aborted) throw Error('RPC request deadline or cancellation');
    const cancel = () => abort.abort();
    options?.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, deadline - Date.now());
    try {
      const params = await readSmallParams(source, abort.signal);
      return await this.#dispatch<T>(binding, method, params, abort.signal);
    } finally { clearTimeout(timer); options?.signal?.removeEventListener('abort', cancel); }
  }

  async connect(): Promise<void> {
    if (this.#closed) throw new CoreHostUnavailableError("远端接入面已经关闭");
    if (this.#started) return;
    await this.control.start();
    this.#started = true;
  }

  async authenticate(): Promise<AuthResult> {
    return {
      protocol: PROTOCOL_VERSION,
      protocolRange: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
      capabilities: ["first-party-current-anchor"],
      server: { version: ZHIXING_CLI_VERSION },
    };
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.#dispatch<T>(this.#currentBinding(method), method, params);
  }

  async consumeEncoded<T, R>(method: string, source: RpcEncodedJsonSource, consumer: (result: T) => R | Promise<R>, options?: Partial<RpcRequestDeadline>): Promise<R> {
    // The existing Mesh envelope is <=1 MiB. Its response has no shared
    // WebSocket receive workspace, but must still complete the consumer.
    return consumer(await this.requestEncoded<T>(method, source, options));
  }

  #currentBinding(method: string): SurfaceBinding {
    if (this.#closed) throw new CoreHostUnavailableError("远端接入面已经关闭");
    if (!isCurrentAnchorRelayMethod(method)) {
      throw new TypeError("设备本地或未知方法不能通过 current anchor 接入面代理");
    }
    const trust = this.control.currentTrust();
    const owner = trust.issuer.deviceId;
    if (owner === this.sourceDeviceId) {
      this.#retireBinding(true);
      throw new CoreHostUnavailableError("当前设备没有可用的本机核心宿主");
    }
    return this.#selectOwner(owner, canonicalize(trust));
  }

  async #dispatch<T>(binding: SurfaceBinding, method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.#requests.size >= 12) throw Error('远端请求处理中，请稍后重试。');
    this.#drainDeadline = Math.max(this.#drainDeadline, Date.now() + 30_000);
    const work = binding.remote.dispatch(method, params, binding.connection, signal);
    this.#requests.add(work);
    try {
      return await work as T;
    } catch (error) {
      if (binding.closed) throw new RpcClientClosedError("远端接入代次已经更换");
      if (error instanceof RpcAppError) throw error;
      throw new CoreHostUnavailableError("值班设备暂时离线，请稍后重试");
    } finally { this.#requests.delete(work); }
  }

  onNotification<T = unknown>(method: string, handler: (params: T) => void): () => void {
    let handlers = this.#methodHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.#methodHandlers.set(method, handlers);
    }
    handlers.add(handler as NotificationHandler);
    return () => {
      handlers!.delete(handler as NotificationHandler);
      if (handlers!.size === 0) this.#methodHandlers.delete(method);
    };
  }

  onAnyNotification(handler: WildcardNotificationHandler): () => void {
    this.#wildcardHandlers.add(handler);
    return () => this.#wildcardHandlers.delete(handler);
  }

  onClose(handler: () => void): () => void {
    if (this.#closed) {
      try { handler(); } catch { /* 订阅者隔离。 */ }
      return () => {};
    }
    this.#closeHandlers.add(handler);
    return () => { this.#closeHandlers.delete(handler); };
  }

  onTurnover(handler: () => void): () => void {
    this.#turnoverHandlers.add(handler);
    return () => { this.#turnoverHandlers.delete(handler); };
  }

  async close(): Promise<void> {
    if (this.#closing) return this.#closing;
    if (this.#closed) return;
    this.#closed = true;
    this.#preparationAbort?.abort();
    this.#retireBinding(false);
    for (const handler of [...this.#closeHandlers]) {
      try { handler(); } catch { /* 订阅者隔离。 */ }
    }
    this.#closeHandlers.clear();
    this.#turnoverHandlers.clear();
    this.#methodHandlers.clear();
    this.#wildcardHandlers.clear();
    this.#closing = (async () => {
      await Promise.all(this.#retiring);
      try { await this.control.stop(); }
      finally { await this.bootstrapStore.stopStorageMaintenance(); }
    })();
    return this.#closing;
  }

  async reconcileOwner(record: HomeTrustRecord): Promise<void> {
    if (this.#closed) return;
    const identity = canonicalize(record);
    if (
      record.issuer.deviceId === this.#binding?.ownerDeviceId &&
      identity === this.#binding.ownerIdentity
    ) return;
    await this.#retireBinding(true);
  }

  #selectOwner(ownerDeviceId: string, ownerIdentity: string): SurfaceBinding {
    if (
      ownerDeviceId === this.#binding?.ownerDeviceId &&
      ownerIdentity === this.#binding.ownerIdentity
    ) return this.#binding;
    const previous = this.#binding;
    this.#retireBinding(false);
    // 每个接入代次有不可变身份及独立 closed 标志；旧 dispatch/poll 永不借用新代。
    const closeHandlers = new Set<() => void>();
    let binding: SurfaceBinding;
    const connection: FirstPartyIngressConnection = {
      id: nextSurfaceConnectionId++,
      get closed() { return binding.closed; },
      authenticated: true,
      loopback: true,
      clientInfo: { id: "zhixing-cli-surface", version: ZHIXING_CLI_VERSION },
      surfacePrincipal: this.#surfacePrincipal,
      surfaceGeneration: ++this.#surfaceGeneration,
      notify: (method, params) => { if (!binding.closed) this.#notify(method, params, binding); },
      onClose: (handler) => {
        closeHandlers.add(handler);
        return () => closeHandlers.delete(handler);
      },
    };
    binding = {
      ownerDeviceId, ownerIdentity, connection, closeHandlers, closed: false,
      remote: new FirstPartyConversationMeshClient(this.control.connections.client(ownerDeviceId), this.sourceDeviceId),
    };
    this.#binding = binding;
    if (previous) this.#notifyTurnover();
    return binding;
  }

  #retireBinding(notify: boolean): Promise<void> | undefined {
    const binding = this.#binding;
    if (!binding) return;
    this.#binding = undefined;
    this.#preparationAbort?.abort();
    binding.closed = true;
    // close 同步停止 poll、撤掉其 close listener；远端收尾不能阻挡本地失效。
    const closing = binding.remote.close(binding.connection).catch(() => {});
    this.#retiring.add(closing);
    void closing.then(() => this.#retiring.delete(closing));
    for (const handler of [...binding.closeHandlers]) {
      try { handler(); } catch { /* 订阅者隔离。 */ }
    }
    binding.closeHandlers.clear();
    if (notify) this.#notifyTurnover();
    return closing;
  }

  #notifyTurnover(): void {
    for (const handler of [...this.#turnoverHandlers]) {
      try { handler(); } catch { /* 订阅者隔离。 */ }
    }
  }

  #notify(method: string, params: unknown, binding: SurfaceBinding): void {
    for (const handler of [...this.#methodHandlers.get(method) ?? []]) {
      if (binding.closed) return;
      try { handler(params); } catch { /* 订阅者隔离。 */ }
    }
    for (const handler of [...this.#wildcardHandlers]) {
      if (binding.closed) return;
      try { handler(method, params); } catch { /* 订阅者隔离。 */ }
    }
  }
}

/** Only the existing small Mesh envelope is decoded. A 100 MiB WebSocket
 * source never enters this fallback. Release the file borrow after real IO. */
async function readSmallParams(source: RpcEncodedJsonSource, signal: AbortSignal): Promise<unknown> {
  if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 1 || source.byteLength > 1024 * 1024) throw Error('远端请求容量无效');
  const reader = source.open();
  try {
    const bytes = Buffer.allocUnsafe(source.byteLength);
    for (let offset = 0; offset < bytes.length;) {
      signal.throwIfAborted();
      const page = await reader.read(offset, Math.min(32 * 1024, bytes.length - offset), signal);
      if (!page.byteLength || page.byteLength > Math.min(32 * 1024, bytes.length - offset)) throw Error('远端参数源不完整');
      bytes.set(page, offset); offset += page.byteLength;
    }
    signal.throwIfAborted();
    return JSON.parse(bytes.toString('utf8'));
  } finally { reader.release(); }
}
