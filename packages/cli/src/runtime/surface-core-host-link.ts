import { randomUUID } from "node:crypto";

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
}): Promise<CurrentAnchorSurfaceRpcClient> {
  const homeDir = options.zhixingHome;
  const configuration = (
    options.configuration ?? createRuntimeConfigurationProvider()
  ).readTopology({ homeDir }).mesh;
  if (!configuration) throw new CoreHostUnavailableError("这台设备尚未完成家庭配置");
  const secretStore = createPlatformSecretStore({ homeDir, context: "foreground" });
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
    const binding = this.#selectOwner(owner, canonicalize(trust));
    try {
      return await binding.remote.dispatch(method, params, binding.connection) as T;
    } catch (error) {
      if (binding.closed) throw new RpcClientClosedError("远端接入代次已经更换");
      if (error instanceof RpcAppError) throw error;
      throw new CoreHostUnavailableError("值班设备暂时离线，请稍后重试");
    }
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
